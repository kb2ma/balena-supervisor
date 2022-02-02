import * as t from 'io-ts';
import { chain, fold } from 'fp-ts/lib/Either';
import { pipe } from 'fp-ts/function';

import { fromEnum } from '../types/basic';

import type { Request, Response, NextFunction } from 'express';
import type { ScopedResources, Scope } from '../lib/api-keys';

export type AuthorizedRequest = Request & {
	auth: {
		isScoped: (resources: Partial<ScopedResources>) => boolean;
		apiKey: string;
		scopes: Scope[];
	};
};

export type AuthorizedRequestHandler = (
	req: AuthorizedRequest,
	res: Response,
	next: NextFunction,
) => void;

/**
 * Host config io-ts types
 */
const disallowedHostConfigPatchFields = ['local_ip', 'local_port'];

enum RedsocksEnum {
	Socks4 = 'socks4',
	Socks5 = 'socks5',
	HttpConnect = 'http-connect',
	HttpRelay = 'http-relay',
}

const RedsocksTypes = fromEnum<string>(
	'RedsocksTypes',
	RedsocksEnum,
	(vals: string[]) =>
		`Invalid redsocks proxy type, must be one of ${vals.join(', ')}`,
);

const NoProxyArray = new t.Type<string[], unknown>(
	'NoProxyArray',
	t.array(t.string).is,
	(i, c) =>
		pipe(
			t.array(t.string).validate(i, c),
			fold(
				() => t.failure(i, c, 'noProxy field must be an array of addresses'),
				t.success,
			),
		),
	t.identity,
);

const HostConfigProxyT = t.partial({
	type: RedsocksTypes,
	noProxy: NoProxyArray,
});

const HostConfigProxy = new t.Type<
	t.TypeOf<typeof HostConfigProxyT>,
	Record<string, unknown>
>(
	'HostConfigProxy',
	HostConfigProxyT.is,
	(i, c) =>
		pipe(
			HostConfigProxyT.validate(i, c),
			chain((obj) => {
				const blacklistedFields = Object.keys(obj).filter((key) =>
					disallowedHostConfigPatchFields.includes(key),
				);
				return blacklistedFields.length > 0
					? t.failure(
							i,
							c,
							`Invalid proxy field(s): ${blacklistedFields.join(', ')}`,
					  )
					: t.success(obj);
			}),
		),
	t.identity,
);

export const HostConfig = t.partial({
	proxy: HostConfigProxy,
});
