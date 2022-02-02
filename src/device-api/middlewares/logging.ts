import * as morgan from 'morgan';

import log from '../../lib/supervisor-console';

/**
 * Request logger
 */
export const logging = morgan(
	(tokens, req, res) =>
		[
			tokens.method(req, res),
			req.path,
			tokens.status(req, res),
			'-',
			tokens['response-time'](req, res),
			'ms',
		].join(' '),
	{
		stream: { write: (d) => log.api(d.toString().trimRight()) },
	},
);
