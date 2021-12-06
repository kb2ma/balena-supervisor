import * as _ from 'lodash';
import * as memoizee from 'memoizee';

import * as db from '../db';
import { generateUniqueKey } from './register-device';

export class KeyNotFoundError extends Error {}

/**
 * The schema for the `apiSecret` table in the database
 */
interface DbApiSecret {
	id: number;
	appId: number;
	serviceName: string;
	scopes: string;
	key: string;
}

export type Scope = SerializableScope<ScopeTypeKey>;
type ScopeTypeKey = keyof ScopeTypes;
type SerializableScope<T extends ScopeTypeKey> = {
	type: T;
} & ScopeTypes[T];
type ScopeCheck<T extends ScopeTypeKey> = (
	resources: Partial<ScopedResources>,
	scope: ScopeTypes[T],
) => Resolvable<boolean>;
type ScopeCheckCollection = {
	[K in ScopeTypeKey]: ScopeCheck<K>;
};

/**
 * The scopes which a key can cover.
 */
type ScopeTypes = {
	global: {};
	app: {
		appId: number;
	};
};

/**
 * The resources which can be protected with scopes.
 */
export interface ScopedResources {
	apps: number[];
}

/**
 * The checks when determining if a key is scoped for a resource.
 */
const scopeChecks: ScopeCheckCollection = {
	global: () => true,
	app: (resources, { appId }) =>
		resources.apps != null && resources.apps.includes(appId),
};

export function serialiseScopes(scopes: Scope[]): string {
	return JSON.stringify(scopes);
}

export function deserialiseScopes(json: string): Scope[] {
	return JSON.parse(json);
}

export const isScoped = (
	resources: Partial<ScopedResources>,
	scopes: Scope[],
) =>
	scopes.some((scope) =>
		scopeChecks[scope.type](resources, (scope as unknown) as any),
	);

// empty until populated in `initialized`
export let cloudApiKey: string = '';

// should be called before trying to use this singleton
export const initialized = (async () => {
	await db.initialized;

	// make sure we have an API key which the cloud will use to call us
	await generateCloudKey();
})();

function isEqualScope(a: Scope, b: Scope): boolean {
	return _.isEqual(a, b);
}

export type GenerateKeyOptions = { force: boolean; scopes: Scope[] };

export async function getScopesForKey(key: string): Promise<Scope[] | null> {
	const apiKey = await getApiKeyByKey(key);

	// null means the key wasn't known...
	if (apiKey == null) {
		return null;
	}

	return deserialiseScopes(apiKey.scopes);
}

export async function generateScopedKey(
	appId: number,
	serviceName: string,
	options?: Partial<GenerateKeyOptions>,
): Promise<string> {
	await initialized;
	return await generateKey(appId, serviceName, options);
}

export async function generateCloudKey(
	force: boolean = false,
): Promise<string> {
	cloudApiKey = await generateKey(0, null, {
		force,
		scopes: [{ type: 'global' }],
	});
	return cloudApiKey;
}

export async function refreshKey(key: string): Promise<string> {
	const apiKey = await getApiKeyByKey(key);

	if (apiKey == null) {
		throw new KeyNotFoundError();
	}

	const { appId, serviceName, scopes } = apiKey;

	// if this is a cloud key that is being refreshed
	if (appId === 0 && serviceName === null) {
		return await generateCloudKey(true);
	}

	// generate a new key, expiring the old one...
	const newKey = await generateScopedKey(appId, serviceName, {
		force: true,
		scopes: deserialiseScopes(scopes),
	});

	// return the regenerated key
	return newKey;
}

/**
 * A cached lookup of the database key
 */
const getApiKeyForService = memoizee(
	async (appId: number, serviceName: string | null): Promise<DbApiSecret[]> => {
		await db.initialized;

		return await db.models('apiSecret').where({ appId, serviceName }).select();
	},
	{
		promise: true,
		maxAge: 60000, // 1 minute
		normalizer: ([appId, serviceName]) => `${appId}-${serviceName}`,
	},
);

/**
 * A cached lookup of the database key for a given application/service pair
 */
const getApiKeyByKey = memoizee(
	async (key: string): Promise<DbApiSecret> => {
		await db.initialized;

		const [apiKey] = await db.models('apiSecret').where({ key }).select();
		return apiKey;
	},
	{
		promise: true,
		maxAge: 60000, // 1 minute
	},
);

/**
 * All key generate logic should come though this method. It handles cache clearing.
 *
 * @param appId
 * @param serviceName
 * @param options
 */
async function generateKey(
	appId: number,
	serviceName: string | null,
	options?: Partial<GenerateKeyOptions>,
): Promise<string> {
	// set default options
	const { force, scopes }: GenerateKeyOptions = {
		force: false,
		scopes: [{ type: 'app', appId }],
		...options,
	};

	// grab the existing API key info
	const secrets = await getApiKeyForService(appId, serviceName);

	// if we need a new key
	if (secrets.length === 0 || force) {
		// are forcing a new key?
		if (force) {
			await db.models('apiSecret').where({ appId, serviceName }).del();
		}

		// remove the cached lookup for the key
		const [apiKey] = secrets;
		if (apiKey != null) {
			getApiKeyByKey.clear(apiKey.key);
		}

		// remove the cached value for this lookup
		getApiKeyForService.clear(appId, serviceName);

		// return a new API key
		return await createNewKey(appId, serviceName, scopes);
	}

	// grab the current secret and scopes
	const [currentSecret] = secrets;
	const currentScopes: Scope[] = JSON.parse(currentSecret.scopes);

	const scopesWeAlreadyHave = scopes.filter((desiredScope) =>
		currentScopes.some((currentScope) =>
			isEqualScope(desiredScope, currentScope),
		),
	);

	// if we have the correct scopes, then return our existing key...
	if (
		scopes.length === currentScopes.length &&
		scopesWeAlreadyHave.length === currentScopes.length
	) {
		return currentSecret.key;
	}

	// forcibly get a new key...
	return await generateKey(appId, serviceName, { ...options, force: true });
}

/**
 * Generates a new key value and inserts it into the DB.
 *
 * @param appId
 * @param serviceName
 * @param scopes
 */
async function createNewKey(
	appId: number,
	serviceName: string | null,
	scopes: Scope[],
) {
	const key = generateUniqueKey();
	await db.models('apiSecret').insert({
		appId,
		serviceName,
		key,
		scopes: serialiseScopes(scopes),
	});

	// return the new key
	return key;
}
