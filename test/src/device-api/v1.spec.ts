import { expect } from 'chai';
import { stub, restore, SinonStub } from 'sinon';
import * as supertest from 'supertest';

import SupervisorAPI from '../../../src/device-api';
import { actions, apiKeys, middleware, v1 } from '../../../src/device-api';
import * as config from '../../../src/config';
import * as deviceState from '../../../src/device-state';
import log from '../../../src/lib/supervisor-console';
import { UpdatesLockedError } from '../../../src/lib/errors';

describe('device-api/v1', () => {
	let api: SupervisorAPI;
	let request: supertest.SuperTest<supertest.Test>;
	const API_PORT = 54321;
	const API_TIMEOUT = 30000;

	before(async () => {
		// Disable log output during testing
		stub(log, 'debug');
		stub(log, 'warn');
		stub(log, 'info');
		stub(log, 'event');
		stub(log, 'success');
		stub(log, 'error');

		// Disable API logger during testing
		stub(middleware, 'apiLogger').callsFake((_req, _res, next) => next());

		// Stub config module to avoid attempts to get sqlite3 configs
		stub(config, 'getMany').callsFake(
			async (_confs): Promise<any> => {
				// middleware.auth requires getting unmanaged and localMode configs
				return Promise.resolve({
					unmanaged: false,
					localMode: false,
				});
			},
		);

		request = supertest(`http://127.0.0.1:${API_PORT}`);
		api = new SupervisorAPI({
			routers: [v1.router],
			healthchecks: [],
		});
		await api.listen(API_PORT, API_TIMEOUT);
		// Generate initial key so test requests have valid auth
		await apiKeys.generateCloudKey();
	});

	after(async () => {
		try {
			await api.stop();
		} catch (e) {
			if ((e as Error).message !== 'Server is not running.') {
				throw e;
			}
		}

		// Restore sinon stubs
		restore();
	});

	describe('GET /v1/healthy', () => {
		let runHealthchecksStub: SinonStub;

		beforeEach(() => {
			runHealthchecksStub = stub(actions, 'runHealthchecks');
		});
		afterEach(() => runHealthchecksStub.restore());

		it('responds with 200 because all healthchecks pass', async () => {
			runHealthchecksStub.resolves(true);
			await request
				.get('/v1/healthy')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(200);
		});

		it('responds with 500 because some healthchecks did not pass', async () => {
			runHealthchecksStub.resolves(false);
			await request
				.get('/v1/healthy')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(500, 'Unhealthy');
		});
	});

	describe('POST /v1/blink', () => {
		let identifyStub: SinonStub;

		beforeEach(() => {
			identifyStub = stub(actions, 'identify');
		});
		afterEach(() => identifyStub.restore());

		it('responds with 200', async () => {
			await request
				.post('/v1/blink')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(200);
		});
	});

	describe('POST /v1/regenerate-api-key', () => {
		let reportStateStub: SinonStub;

		beforeEach(() => {
			reportStateStub = stub(deviceState, 'reportCurrentState');
		});
		afterEach(async () => {
			reportStateStub.restore();
			await apiKeys.generateCloudKey();
		});

		it('returns 200 and a valid new API key', async () => {
			let newKey = '';

			await request
				.post('/v1/regenerate-api-key')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(200)
				.then(({ text }) => {
					newKey = text;
				});

			// Ensure new key validity
			await request
				.post('/v1/blink')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${newKey}`)
				.expect(200);
		});

		it('expires old API key after generating new key', async () => {
			const oldKey = apiKeys.cloudApiKey;

			await request
				.post('/v1/regenerate-api-key')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${oldKey}`)
				.expect(200);

			// Ensure old key was expired
			await request
				.post('/v1/restart')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${oldKey}`)
				.expect(401);
		});
	});

	describe('POST /v1/restart', () => {
		let restartStub: SinonStub;

		beforeEach(() => {
			restartStub = stub(actions, 'doRestart').resolves();
		});
		afterEach(() => restartStub.restore());

		it('parses force from request body', async () => {
			await request
				.post('/v1/restart')
				.send({ appId: 1234567, force: false })
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(200);
			expect(restartStub).to.have.been.calledWith(1234567, false);

			restartStub.resetHistory();

			await request
				.post('/v1/restart')
				.send({ appId: 7654321, force: true })
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(200);
			expect(restartStub).to.have.been.calledWith(7654321, true);
		});

		it('responds with 400 if appId is missing', async () => {
			await request
				.post('/v1/restart')
				.send({})
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(400);
		});

		it("responds with 401 if caller's API key is not in scope of appId", async () => {
			const scopedKey = await apiKeys.generateScopedKey(1234567, 'main');
			await request
				.post('/v1/restart')
				.send({ appId: 7654321 })
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${scopedKey}`)
				.expect(401);
		});

		it('responds with 200 if restart succeeded', async () => {
			await request
				.post('/v1/restart')
				.send({ appId: 1234567 })
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(200);
		});

		it('responds with 423 if there are update locks', async () => {
			restartStub.throws(new UpdatesLockedError());
			await request
				.post('/v1/restart')
				.send({ appId: 1234567 })
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(423);
		});

		it('responds with 503 for other errors that occur during restart', async () => {
			restartStub.throws(new Error());
			await request
				.post('/v1/restart')
				.send({ appId: 1234567 })
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(503);
		});
	});
});
