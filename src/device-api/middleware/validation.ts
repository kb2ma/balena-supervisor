import * as t from 'io-ts';
import { isRight, Right, Left, fold } from 'fp-ts/lib/Either';
import { pipe } from 'fp-ts/lib/function';
import { Response } from 'express';

import * as messages from '../messages';
import * as config from '../../config';
import {
	NumericIdentifier,
	BooleanIdentifier,
	DockerName,
	AuthorizedRequest,
	AuthorizedRequestHandler,
	HostConfig,
	withDefault,
} from '../../types';
import log from '../../lib/supervisor-console';

/**
 * Input validation schemas
 */
type BaseT = {
	name: string;
	location: 'body' | 'params' | 'query';
	type: t.Type<any>;
};
type WithMessageT = {
	warn: boolean; // warn instead of erroring if present
	getMessage: (
		req: AuthorizedRequest,
	) => string | { status: string; message: string };
};

type RequiredValidationT = BaseT &
	WithMessageT & {
		self: 'required';
		getErrorCode: (req: AuthorizedRequest) => number;
	};
type OptionalValidationT = BaseT &
	Partial<WithMessageT> & {
		self: 'optional';
		getDefault?: () => Promise<any>;
		shouldDefault?: (val: any) => boolean;
	};
type OneOfRequiredValidationT = {
	schemas: RequiredValidationT[];
};
type ValidationT = RequiredValidationT | OptionalValidationT;

// The following input validation schemas are used in multiple routes in
// the master inputValidationSchema, so they are declared here to reduce repetition
const appIdSchema: RequiredValidationT = {
	name: 'appId',
	location: 'params',
	type: NumericIdentifier,
	self: 'required',
	warn: false,
	getErrorCode: () => 400,
	// This is unpleasant but necessary because of differing
	// error messages some endpoints. v1 endpoints send a string
	// while v2 endpoints send a JSON.
	getMessage: (req: AuthorizedRequest) =>
		req.path.includes('v1')
			? messages.missingAppIdInputErrorMessage
			: {
					status: 'failed',
					message: messages.missingAppIdInputErrorMessage,
			  },
};

const forceSchema: OptionalValidationT = {
	name: 'force',
	location: 'body',
	type: BooleanIdentifier,
	self: 'optional',
	shouldDefault: (val) => val !== true,
	getDefault: () => config.get('lockOverride'),
};

const getInvalidServiceOrImageErrorCode = (req: AuthorizedRequest) =>
	!req.body.imageId && !req.body.serviceName ? 523 : 404;

const getInvalidServiceOrImageMessage = (req: AuthorizedRequest) =>
	!req.body.imageId && !req.body.serviceName
		? {
				status: 'failed',
				message: messages.v2ServiceEndpointInputErrorMessage,
		  }
		: messages.serviceNotFoundMessage;

// Unfortunately, if neither imageId nor serviceName exist in the request body
// of certain v2 routes, we get an incorrect status code of 523 (it should be 4xx).
// We need to keep the user interface consistent even if it's wrong.
//
// If imageId/serviceName exist in req.body, we only need to check them for io-ts type
// validity before passing them to the main route handler. The main route handler will
// check if imageId/serviceName corresponds to an actual running service, and return a 404
// otherwise. Therefore we return a 404 if an invalid type is found to simulate this
// future 404, because there's a 0% chance that an imageId/serviceName with an invalid
// format will exist on the device.
const serviceNameOrImageIdSchema: OneOfRequiredValidationT = {
	schemas: [
		{
			name: 'imageId',
			location: 'body',
			type: NumericIdentifier,
			self: 'required',
			warn: false,
			getErrorCode: getInvalidServiceOrImageErrorCode,
			getMessage: getInvalidServiceOrImageMessage,
		},
		{
			name: 'serviceName',
			location: 'body',
			type: DockerName,
			self: 'required',
			warn: false,
			getErrorCode: getInvalidServiceOrImageErrorCode,
			getMessage: getInvalidServiceOrImageMessage,
		},
	],
};

/**
 * Source of truth for input validation functions & responses for all
 * API routes. Create one or more input validation schema(s) for any new
 * routes that require validation here.
 */
const inputValidationSchema: {
	[key: string]: {
		required?: Array<RequiredValidationT | OneOfRequiredValidationT>;
		optional?: OptionalValidationT[];
	};
} = {
	'POST /v1/restart': {
		required: [
			// One of two legacy endpoints that require appId in req.body
			{ ...appIdSchema, location: 'body' },
		],
		optional: [forceSchema],
	},
	'POST /v1/apps/:appId/stop': {
		required: [appIdSchema],
		optional: [forceSchema],
	},
	'POST /v1/apps/:appId/start': {
		required: [appIdSchema],
		optional: [forceSchema],
	},
	'POST /v1/reboot': {
		optional: [forceSchema],
	},
	'POST /v1/shutdown': {
		optional: [forceSchema],
	},
	'GET /v1/apps/:appId': {
		required: [appIdSchema],
	},
	'POST /v1/purge': {
		required: [
			{
				...appIdSchema,
				// One of two legacy endpoints that require appId in req.body
				location: 'body',
				// This message is slightly different than the other v1 validation error messages
				getMessage: () => 'Invalid or missing appId',
			},
		],
		optional: [forceSchema],
	},
	'POST /v1/update': {
		optional: [forceSchema],
	},
	'PATCH /v1/device/host-config': {
		optional: [
			{
				// Because v1 endpoints are legacy, and this endpoint might already be used
				// by multiple users, adding too many throws might have unintended side effects.
				// Thus we're simply logging invalid fields and allowing the request to continue.
				name: 'network',
				location: 'body',
				type: HostConfig,
				self: 'optional',
				warn: true,
				getMessage: () => "Key 'network' must exist in PATCH body",
			},
		],
	},
	'POST /v2/applications/:appId/purge': {
		required: [appIdSchema],
		optional: [forceSchema],
	},
	'POST /v2/applications/:appId/restart-service': {
		required: [appIdSchema, serviceNameOrImageIdSchema],
		optional: [forceSchema],
	},
	'POST /v2/applications/:appId/stop-service': {
		required: [appIdSchema, serviceNameOrImageIdSchema],
		optional: [forceSchema],
	},
	'POST /v2/applications/:appId/start-service': {
		required: [appIdSchema, serviceNameOrImageIdSchema],
		optional: [forceSchema],
	},
	'POST /v2/applications/:appId/restart': {
		required: [appIdSchema],
		optional: [forceSchema],
	},
	'GET /v2/applications/:appId/state': {
		required: [
			{
				...appIdSchema,
				// This single v2 endpoint has a slightly different error message than the other v2s
				getMessage: (req: AuthorizedRequest) => ({
					status: 'failed',
					message: `Invalid application ID: ${req.params.appId}`,
				}),
			},
		],
	},
	'POST /v2/local/target-state': {
		// We don't need required even though the entire req.body is the target state
		// because it's validated by the io-ts codecs for target state
		// in deviceState.setTarget, which is called within this route.
		optional: [forceSchema],
	},
	'GET /v2/containerId': {
		required: [
			// We only need to verify that serviceName \ service are
			// valid io-ts DockerName types because there's a 0% chance of a service existing
			// with an invalid serviceName as the engine won't allow it. Actual checking of
			// whether a service exists with a valid name can be handled after input validation.
			{
				schemas: [
					{
						name: 'serviceName',
						location: 'query',
						type: DockerName,
						self: 'required',
						warn: false,
						getErrorCode: () => 503,
						getMessage: () => ({
							status: 'failed',
							message: messages.serviceNameNotFoundMessage,
						}),
					},
					{
						name: 'service',
						location: 'query',
						type: DockerName,
						self: 'required',
						warn: false,
						getErrorCode: () => 503,
						getMessage: () => ({
							status: 'failed',
							message: messages.serviceNameNotFoundMessage,
						}),
					},
				],
			},
		],
	},
	'POST /v2/journal-logs': {
		optional: [
			{
				name: 'all',
				location: 'body',
				type: t.boolean,
				self: 'optional',
				shouldDefault: (val) => val !== true,
				getDefault: () => Promise.resolve(false),
			},
			{
				name: 'follow',
				location: 'body',
				type: t.boolean,
				self: 'optional',
				shouldDefault: (val) => val !== true,
				getDefault: () => Promise.resolve(false),
			},
			{
				name: 'count',
				location: 'body',
				type: t.union([t.number, t.null]),
				self: 'optional',
				// Not a positive integer
				shouldDefault: (val) =>
					isNaN(+val) || +val !== parseInt(val.toString(), 10) || +val <= 0,
				getDefault: () => Promise.resolve(null),
			},
			{
				name: 'unit',
				location: 'body',
				type: t.union([t.string, t.null]),
				self: 'optional',
				getDefault: () => Promise.resolve(null),
			},
			{
				name: 'format',
				location: 'body',
				type: t.string,
				self: 'optional',
				getDefault: () => Promise.resolve('short'),
			},
			{
				name: 'containerId',
				location: 'body',
				type: t.union([t.string, t.null]),
				self: 'optional',
				getDefault: () => Promise.resolve(null),
			},
		],
	},
};

/**
 * Input validation middleware
 */
// Look behind for paths with the format /v[1-2]/apps | /v[1-2]/applications.
// appId is always specified as a route param after this pattern, for existing
// endpoints. If adding new endpoints with an appId param, either follow this
// pattern, or modify this regex to apply to your new pattern, but make sure
// the new pattern is followed consistently.
const appIdRegex = /(?<=\/v[1-2]\/(?:apps|applications)\/)([a-zA-Z0-9]+)/;
/**
 * Given an express request object, extract the method and path
 * in the format METHOD /path, replacing parameters with generics
 *
 * Examples:
 * 	- POST /v1/restart
 *  - GET /v2/applications/:appId
 */
const getRouteMethodAndPath = (req: AuthorizedRequest): string => {
	let path = req.path;
	const match = path.match(appIdRegex);

	// Replace parameter appId with ':appId' to be able to find schema by generic key.
	// This is because req.path includes the actual appId parameter (i.e. 1234567, 1)
	// instead of the generic appId parameter pattern (i.e. ':appId'), and req.route.path
	// is the same.
	if (match) {
		path = req.path.replace(appIdRegex, ':appId');
		// Attach appId to params for decoding, since Express doesn't know to generate
		// a params object for a 'generic' middleware imported using `app.use`. To
		// get a generated req.params at this point, we would need to include this
		// middleware at the route level, i.e. route.get('/test', thisMiddleware, (req, res) => {})
		req.params.appId = match[1];
	}

	return `${req.method} ${path}`;
};

/**
 * When provided with an input validation schema of type ValidationT or
 * its derivatives, get the io-ts decoded value from the input.
 */
const getDecodedInput = async (
	req: AuthorizedRequest,
	schema: ValidationT,
): Promise<{ decoded: t.Validation<any>; schema: ValidationT }> => {
	const { name, location } = schema;

	// Modify type with withDefault if schema requires a default.
	// This means that invalid inputs will fallback to a default value.
	const type =
		schema.self === 'optional' && schema.getDefault
			? withDefault(
					schema.type,
					await schema.getDefault(),
					schema.shouldDefault,
			  )
			: schema.type;

	// Decode and return with a reference to schema
	return { decoded: type.decode(req[location][name]), schema };
};

/**
 * Given a OneOfRequiredValidationT schema, return the decoded input for the first
 * schema that decodes to an io-ts Right type, or the first Left type if no Rights.
 */
const getFirstValidSchema = async (
	req: AuthorizedRequest,
	schema: OneOfRequiredValidationT,
): ReturnType<typeof getDecodedInput> => {
	// Get nested schemas from schema
	const { schemas } = schema;

	// Decode subschemas
	let firstLeft: any;
	for (let i = 0; i < schemas.length; i++) {
		const di = await getDecodedInput(req, schemas[i]);
		if (i === 0) {
			firstLeft = di;
		}
		if (isRight(di.decoded)) {
			return di;
		}
	}
	// Return first Left schema if no Right schemas are found
	return firstLeft;
};

const getDecodedFromSchemas = (
	req: AuthorizedRequest,
	schemas: Array<ValidationT | OneOfRequiredValidationT>,
): Array<ReturnType<typeof getDecodedInput>> => {
	return schemas.map((schema) => {
		// Satisfies type OneOfRequiredValidationT
		if ('schemas' in schema) {
			return getFirstValidSchema(req, schema as OneOfRequiredValidationT);
		}

		return getDecodedInput(req, schema);
	});
};

/**
 * Extract error messages from one or more io-ts Lefts.
 */
const getMessagesFromLefts = (
	decoded: Left<t.Errors>,
): Set<string | { [key: string]: string }> =>
	decoded.left.reduce((msgs: Set<string>, { message }) => {
		if (message && !msgs.has(message)) {
			msgs.add(message);
		}
		return msgs;
	}, new Set<string | { [key: string]: string }>());

// Handle the case of a decoded input with a type of Right (i.e. a valid input)
// Set validated, decoded value in res.locals object, which scopes the variable
// to the current request only.
const handleRight = (res: Response, schema: ValidationT, decoded: Right<any>) =>
	(res.locals[schema.name] = decoded.right);

// Handle the case of a decoded input with an io-ts type of Left (i.e. an invalid input)
const handleLeft = (
	req: AuthorizedRequest,
	res: Response,
	schema: ValidationT,
	decoded: Left<t.Errors>,
	warnFn: (s: any) => any,
) => {
	// Warn instead of erroring if schema specifies it
	if (schema.warn) {
		// Get warning messages from Left.message
		const warnMessages = getMessagesFromLefts(decoded);

		// If no warn messages, get message from schema if it exists
		if (!warnMessages.size && schema.getMessage) {
			const schemaWarnMessage = schema.getMessage(req);
			if (schemaWarnMessage) {
				warnMessages.add(schemaWarnMessage);
			}
		}

		// Run warnFn on all messages -- this should generally be log.warn from supervisor-console.ts
		warnMessages.forEach((msg) => warnFn(msg));
		return;
	}

	// Send error message
	if (schema.self === 'required') {
		const errMessage = schema.getMessage(req);
		const errCode = schema.getErrorCode(req);
		return res.status(errCode).send(errMessage);
	}

	// If an optional type exists but warn isn't specified, proceed with
	// the original, invalid value because we need to maintain legacy interfaces.
	return;
};

/**
 * Validates request inputs using io-ts and an input schema.
 */
export const inputValidator: AuthorizedRequestHandler = async (
	req,
	res,
	next,
) => {
	const methodAndPath = getRouteMethodAndPath(req);
	const validationSchema = inputValidationSchema[methodAndPath];

	// Continue to route if there are no inputs requiring validation for the route
	if (!validationSchema) {
		return next();
	}

	const schemas = (validationSchema.required ?? []).concat(
		(validationSchema.optional as any) ?? [],
	);
	const decodedInputs = await Promise.all(getDecodedFromSchemas(req, schemas));

	for (const { decoded, schema } of decodedInputs) {
		pipe(
			decoded,
			fold(
				// Warn to Supervisor console, or send an error response
				() => handleLeft(req, res, schema, decoded as Left<any>, log.warn),
				// Add parsed input values to res.locals for access later in the request
				() => handleRight(res, schema, decoded as Right<any>),
			),
		);

		// We don't `return handleLeft` above in case it's not an instance of a
		// 4xx or 5xx response being sent, since that may cut off the decode handler
		// loop prematurely. res.writableEnded only returns true when a response has
		// already been sent, so it's safe to return from the middleware here.
		if (res.writableEnded) {
			return;
		}
	}

	// Check auth scope against decoded appId
	if (res.locals.appId && !req.auth.isScoped({ apps: [res.locals.appId] })) {
		// If not scoped, return auth error message
	}

	// return next();
	return res.status(200).send('OK');
};
