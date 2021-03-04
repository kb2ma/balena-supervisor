import { DockerProgress, ProgressCallback } from 'docker-progress';
import * as Dockerode from 'dockerode';
import * as _ from 'lodash';
import * as memoizee from 'memoizee';
import DockerToolbelt = require('docker-toolbelt');

import { SchemaReturn } from '../config/schema-type';
import { envArrayToObject } from './conversions';
import {
	DeltaStillProcessingError,
	ImageAuthenticationError,
	InvalidNetGatewayError,
} from './errors';
import * as request from './request';
import { EnvVarObject } from './types';

import log from './supervisor-console';

export type FetchOptions = SchemaReturn<'fetchOptions'>;
export type DeltaFetchOptions = FetchOptions & {
	deltaSourceId: string;
	deltaSource: string;
};

// TODO: Correctly export this from docker-toolbelt
interface ImageNameParts {
	registry: string;
	imageName: string;
	tagName: string;
	digest: string;
}

// How long do we keep a delta token before invalidating it
// (10 mins)
const DELTA_TOKEN_TIMEOUT = 10 * 60 * 1000;

export const docker = new Dockerode();
export const dockerToolbelt = new DockerToolbelt(undefined);
export const dockerProgress = new DockerProgress({
	dockerToolbelt,
});

export async function getRepoAndTag(
	image: string,
): Promise<{ repo: string; tag: string }> {
	const {
		registry,
		imageName,
		tagName,
	} = await dockerToolbelt.getRegistryAndName(image);

	let repoName = imageName;

	if (registry != null) {
		repoName = `${registry}/${imageName}`;
	}

	return { repo: repoName, tag: tagName };
}

export async function fetchDeltaWithProgress(
	imgDest: string,
	deltaOpts: DeltaFetchOptions,
	onProgress: ProgressCallback,
	serviceName: string,
): Promise<string> {
	const logFn = (str: string) =>
		log.debug(`delta([${serviceName}] ${deltaOpts.deltaSource}): ${str}`);

	if (deltaOpts.deltaVersion !== 3) {
		logFn(
			`Unsupported delta version: ${deltaOpts.deltaVersion}. Falling back to regular pull`,
		);
		return await fetchImageWithProgress(imgDest, deltaOpts, onProgress);
	}

	/**
	 * Update will fail when applying a v3 delta on top of a v2 delta, since rsync deltas
	 * lack the metadata needed to make them "proper" docker images, so resort to a regular
	 * image pull. Even if the update path to OS 3 involves an update to OS 2, which
	 * includes Supervisors that know how to migrate rsync deltas, if the user does not
	 * push a new release between OS versions, local images may still be in an incompatible
	 * format. OS 3 will need to know how to handle v2 deltas until all devices on the platform
	 * have migrated.
	 */
	if (
		deltaOpts.deltaVersion === 3 &&
		(await isV2DeltaImage(deltaOpts.deltaSourceId))
	) {
		logFn(`Cannot create a delta from V2 to V3, falling back to regular pull`);
		return await fetchImageWithProgress(imgDest, deltaOpts, onProgress);
	}

	// Since the supevisor never calls this function with a source anymore,
	// this should never happen, but we handle it anyway
	if (deltaOpts.deltaSource == null) {
		logFn('Falling back to regular pull due to lack of a delta source');
		return fetchImageWithProgress(imgDest, deltaOpts, onProgress);
	}

	logFn(`Starting delta to ${imgDest}`);

	const [dstInfo, srcInfo] = await Promise.all([
		dockerToolbelt.getRegistryAndName(imgDest),
		dockerToolbelt.getRegistryAndName(deltaOpts.deltaSource),
	]);

	const token = await getAuthToken(srcInfo, dstInfo, deltaOpts);

	const opts: request.requestLib.CoreOptions = {
		followRedirect: false,
		timeout: deltaOpts.deltaRequestTimeout,
		auth: {
			bearer: token,
			sendImmediately: true,
		},
	};

	const url = `${deltaOpts.deltaEndpoint}/api/v${deltaOpts.deltaVersion}/delta?src=${deltaOpts.deltaSource}&dest=${imgDest}`;

	const [res, data] = await (await request.getRequestInstance()).getAsync(
		url,
		opts,
	);
	if (res.statusCode === 502 || res.statusCode === 504) {
		throw new DeltaStillProcessingError();
	}
	let id: string;
	try {
		switch (deltaOpts.deltaVersion) {
			case 3:
				if (res.statusCode !== 200) {
					throw new Error(
						`Got ${res.statusCode} when requesting v3 delta from delta server.`,
					);
				}
				let name;
				try {
					name = JSON.parse(data).name;
				} catch (e) {
					throw new Error(
						`Got an error when parsing delta server response for v3 delta: ${e}`,
					);
				}
				id = await applyBalenaDelta(name, token, onProgress, logFn);
				break;
			default:
				throw new Error(`Unsupported delta version: ${deltaOpts.deltaVersion}`);
		}
	} catch (e) {
		logFn(`Delta failed with ${e}`);
		throw e;
	}

	logFn(`Delta applied successfully`);
	return id;
}

export async function fetchImageWithProgress(
	image: string,
	{ uuid, currentApiKey }: FetchOptions,
	onProgress: ProgressCallback,
): Promise<string> {
	const { registry } = await dockerToolbelt.getRegistryAndName(image);

	const dockerOpts = {
		authconfig: {
			username: `d_${uuid}`,
			password: currentApiKey,
			serverAddress: registry,
		},
	};

	await dockerProgress.pull(image, onProgress, dockerOpts);
	return (await docker.getImage(image).inspect()).Id;
}

export async function getImageEnv(id: string): Promise<EnvVarObject> {
	const inspect = await docker.getImage(id).inspect();

	try {
		return envArrayToObject(_.get(inspect, ['Config', 'Env'], []));
	} catch (e) {
		log.error('Error getting env from image', e);
		return {};
	}
}

export async function getNetworkGateway(networkName: string): Promise<string> {
	if (networkName === 'host') {
		return '127.0.0.1';
	}

	const network = await docker.getNetwork(networkName).inspect();
	const config = _.get(network, ['IPAM', 'Config', '0']);
	if (config != null) {
		if (config.Gateway != null) {
			return config.Gateway;
		}
		if (config.Subnet != null && _.endsWith(config.Subnet, '.0/16')) {
			return config.Subnet.replace('.0/16', '.1');
		}
	}
	throw new InvalidNetGatewayError(
		`Cannot determine network gateway for ${networkName}`,
	);
}

async function applyBalenaDelta(
	deltaImg: string,
	token: string | null,
	onProgress: ProgressCallback,
	logFn: (str: string) => void,
): Promise<string> {
	logFn('Applying balena delta...');

	let auth: Dictionary<unknown> | undefined;
	if (token != null) {
		logFn('Using registry auth token');
		auth = {
			authconfig: {
				registrytoken: token,
			},
		};
	}

	await dockerProgress.pull(deltaImg, onProgress, auth);
	return (await docker.getImage(deltaImg).inspect()).Id;
}

export async function isV2DeltaImage(imageName: string): Promise<boolean> {
	const inspect = await docker.getImage(imageName).inspect();

	// It's extremely unlikely that an image is valid if
	// it's smaller than 40 bytes, but a v2 delta always is.
	// For this reason, this is the method that we use to
	// detect when an image is a v2 delta
	return inspect.Size < 40 && inspect.VirtualSize < 40;
}

const getAuthToken = memoizee(
	async (
		srcInfo: ImageNameParts,
		dstInfo: ImageNameParts,
		deltaOpts: DeltaFetchOptions,
	): Promise<string> => {
		const tokenEndpoint = `${deltaOpts.apiEndpoint}/auth/v1/token`;
		const tokenOpts: request.requestLib.CoreOptions = {
			auth: {
				user: `d_${deltaOpts.uuid}`,
				pass: deltaOpts.currentApiKey,
				sendImmediately: true,
			},
			json: true,
		};
		const tokenUrl = `${tokenEndpoint}?service=${dstInfo.registry}&scope=repository:${dstInfo.imageName}:pull&scope=repository:${srcInfo.imageName}:pull`;

		const tokenResponseBody = (
			await (await request.getRequestInstance()).getAsync(tokenUrl, tokenOpts)
		)[1];
		const token = tokenResponseBody != null ? tokenResponseBody.token : null;

		if (token == null) {
			throw new ImageAuthenticationError('Authentication error');
		}

		return token;
	},
	{ maxAge: DELTA_TOKEN_TIMEOUT, promise: true },
);
