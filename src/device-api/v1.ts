import * as express from 'express';
import * as _ from 'lodash';

import * as eventTracker from '../event-tracker';
import * as apiBinder from '../api-binder';
import * as config from '../config';
import * as deviceState from '../device-state';
import * as TargetState from '../device-state/target-state';
import { getApp } from '../device-state/db-format';
import * as hostConfig from '../host-config';
import { AuthorizedRequest } from '../types';
import { doRestart, doPurge } from './common';

import * as constants from '../lib/constants';
import log from '../lib/supervisor-console';
import { UpdatesLockedError } from '../lib/errors';
import * as applicationManager from '../compose/application-manager';
import { generateStep } from '../compose/composition-steps';
import * as commitStore from '../compose/commit';

export const router = express.Router();

router.post('/v1/restart', (_req: AuthorizedRequest, res, next) => {
	// Get validated input(s) which are stored in res.locals during middleware.inputValidator
	const { appId, force } = res.locals;
	eventTracker.track('Restart container (v1)', { appId });

	return doRestart(appId, force)
		.then(() => res.status(200).send('OK'))
		.catch(next);
});

const stopOrStart = (
	req: AuthorizedRequest,
	res: express.Response,
	next: express.NextFunction,
	action: 'start' | 'stop',
) => {
	// Get validated input(s) which are stored in res.locals during middleware.inputValidator
	const { appId, force } = res.locals;

	return Promise.all([applicationManager.getCurrentApps(), getApp(appId)])
		.then(([apps, targetApp]) => {
			if (apps[appId] == null) {
				return res.status(400).send('App not found');
			}
			const app = apps[appId];
			let service = app.services[0];
			if (service == null) {
				return res.status(400).send('No services on app');
			}
			if (app.services.length > 1) {
				return res
					.status(400)
					.send('Some v1 endpoints are only allowed on single-container apps');
			}

			// check that the request is scoped to cover this application
			if (!req.auth.isScoped({ apps: [app.appId] })) {
				return res.status(401).send('Unauthorized');
			}

			// Get the service from the target state (as we do in v2)
			// TODO: what if we want to start a service belonging to the current app?
			const targetService = _.find(targetApp.services, {
				serviceName: service.serviceName,
			});

			applicationManager.setTargetVolatileForService(service.imageId, {
				running: action !== 'stop',
			});

			const stopOpts = { wait: true };
			const step = generateStep(action, {
				current: service,
				target: targetService,
				...stopOpts,
			});

			return applicationManager
				.executeStep(step, { force })
				.then(function () {
					if (action === 'stop') {
						return service;
					}
					// We refresh the container id in case we were starting an app with no container yet
					return applicationManager.getCurrentApps().then(function (apps2) {
						const app2 = apps2[appId];
						service = app2.services[0];
						if (service == null) {
							throw new Error('App not found after running action');
						}
						return service;
					});
				})
				.then((service2) =>
					res.status(200).json({ containerId: service2.containerId }),
				);
		})
		.catch(next);
};

const createStopOrStartHandler = (action: 'start' | 'stop') =>
	_.partial(stopOrStart, _, _, _, action);

router.post('/v1/apps/:appId/stop', createStopOrStartHandler('stop'));
router.post('/v1/apps/:appId/start', createStopOrStartHandler('start'));

const rebootOrShutdown = async (
	_req: express.Request,
	res: express.Response,
	action: deviceState.DeviceStateStepTarget,
) => {
	// Get validated input(s) which are stored in res.locals during middleware.inputValidator
	const { force } = res.locals;
	try {
		const response = await deviceState.executeStepAction({ action }, { force });
		res.status(202).json(response);
	} catch (e) {
		const status = e instanceof UpdatesLockedError ? 423 : 500;
		res.status(status).json({
			Data: '',
			Error: (e != null ? e.message : undefined) || e || 'Unknown error',
		});
	}
};
router.post('/v1/reboot', (req, res) => rebootOrShutdown(req, res, 'reboot'));
router.post('/v1/shutdown', (req, res) =>
	rebootOrShutdown(req, res, 'shutdown'),
);

router.get('/v1/apps/:appId', async (_req: AuthorizedRequest, res, next) => {
	// Get validated input(s) which are stored in res.locals during middleware.inputValidator
	const { appId } = res.locals;
	eventTracker.track('GET app (v1)', { appId });

	try {
		const apps = await applicationManager.getCurrentApps();
		const app = apps[appId];
		const service = app?.services?.[0];
		if (service == null) {
			return res.status(400).send('App not found');
		}

		if (app.services.length > 1) {
			return res
				.status(400)
				.send('Some v1 endpoints are only allowed on single-container apps');
		}

		// Because we only have a single app, we can fetch the commit for that
		// app, and maintain backwards compatability
		const commit = await commitStore.getCommitForApp(appId);

		// Don't return data that will be of no use to the user
		const appToSend = {
			appId,
			commit,
			containerId: service.containerId,
			env: _.omit(service.config.environment, constants.privateAppEnvVars),
			imageId: service.config.image,
			releaseId: service.releaseId,
		};

		return res.json(appToSend);
	} catch (e) {
		next(e);
	}
});

router.post('/v1/purge', (_req: AuthorizedRequest, res, next) => {
	// Get validated input(s) which are stored in res.locals during middleware.inputValidator
	const { appId, force } = res.locals;

	return doPurge(appId, force)
		.then(() => res.status(200).json({ Data: 'OK', Error: '' }))
		.catch(next);
});

router.post('/v1/update', (_req: AuthorizedRequest, res, next) => {
	// Get validated input(s) which are stored in res.locals during middleware.inputValidator
	const { force } = res.locals;

	eventTracker.track('Update notification');
	if (apiBinder.isReadyForUpdates()) {
		config
			.get('instantUpdates')
			.then((instantUpdates) => {
				if (instantUpdates) {
					TargetState.update(force, true).catch(_.noop);
					res.sendStatus(204);
				} else {
					log.debug(
						'Ignoring update notification because instant updates are disabled',
					);
					res.sendStatus(202);
				}
			})
			.catch(next);
	} else {
		res.sendStatus(202);
	}
});

router.get('/v1/device/host-config', (_req, res) =>
	hostConfig
		.get()
		.then((conf) => res.json(conf))
		.catch((err) =>
			res.status(503).send(err?.message ?? err ?? 'Unknown error'),
		),
);

router.patch('/v1/device/host-config', async (req, res) => {
	try {
		// If hostname is an empty string, return first 7 digits of device uuid
		if (req.body.network?.hostname === '') {
			const uuid = await config.get('uuid');
			req.body.network.hostname = uuid?.slice(0, 7);
		}

		await hostConfig.patch(req.body);
		res.status(200).send('OK');
	} catch (err) {
		res.status(503).send(err?.message ?? err ?? 'Unknown error');
	}
});

router.get('/v1/device', async (_req, res) => {
	try {
		const state = await deviceState.getStatus();
		const stateToSend = _.pick(state.local, [
			'api_port',
			'ip_address',
			'os_version',
			'mac_address',
			'supervisor_version',
			'update_pending',
			'update_failed',
			'update_downloaded',
		]) as Dictionary<unknown>;
		if (state.local?.is_on__commit != null) {
			stateToSend.commit = state.local.is_on__commit;
		}
		const service = _.toPairs(
			_.toPairs(state.local?.apps)[0]?.[1]?.services,
		)[0]?.[1];

		if (service != null) {
			stateToSend.status = service.status;
			if (stateToSend.status === 'Running') {
				stateToSend.status = 'Idle';
			}
			stateToSend.download_progress = service.download_progress;
		}
		res.json(stateToSend);
	} catch (e) {
		res.status(500).json({
			Data: '',
			Error: (e != null ? e.message : undefined) || e || 'Unknown error',
		});
	}
});
