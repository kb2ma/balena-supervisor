import * as t from 'io-ts';
import { chain, fold, isRight } from 'fp-ts/lib/Either';
import { pipe } from 'fp-ts/function';

export const NullOrUndefined = t.union([t.undefined, t.null]);
const isNullOrUndefined = (val: any) => isRight(NullOrUndefined.decode(val));

// Utility type function which returns a type with a default value
export const withDefault = <T extends t.Any>(
	type: T,
	defaultValue: t.TypeOf<T>,
	shouldDefault: (val: t.TypeOf<T>) => boolean = isNullOrUndefined,
): t.Type<t.TypeOf<T>> =>
	new t.Type(
		type.name,
		type.is,
		(v, c) => type.validate(shouldDefault(v) ? defaultValue : v, c),
		type.encode,
	);

/**
 * A short string is a non null string between
 * 0 and 255 characters
 */
export const ShortString = new t.Type<string, string>(
	'ShortString',
	(i: unknown): i is string => t.string.is(i) && i.length <= 255,
	(i, c) =>
		pipe(
			t.string.validate(i, c),
			chain((s) =>
				s.length <= 255
					? t.success(s)
					: t.failure(s, c, 'must be at most 255 chars long'),
			),
		),
	t.identity,
);

// Note: assigning this type to a string will not throw compilation errorrs.
//
// e.g. the following will compile without issues.
// ```
// const x: ShortString = 'a'.repeat(300);
// ```
export type ShortString = t.TypeOf<typeof ShortString>;

/**
 * A string identifier is a string that encodes a
 * positive integer (an id to be used as a database id)
 *
 * e.g.
 * Invalid decimal strings: 'aaa', '0xaaa'
 * Valid decimal strings: '0', '123'
 */
export const StringIdentifier = new t.Type<string, string>(
	'StringIdentifier',
	(i: unknown): i is string =>
		t.string.is(i) && !isNaN(+i) && +i === parseInt(i, 10) && +i >= 0,
	(i, c) =>
		pipe(
			t.string.validate(i, c),
			chain((s) =>
				!isNaN(+s) && +s === parseInt(s, 10) && +s >= 0
					? t.success(s)
					: t.failure(s, c, 'must be a positive integer'),
			),
		),
	String,
);

export type StringIdentifier = t.TypeOf<typeof StringIdentifier>;

export const StringOrNumber = t.union([t.number, t.string]);
export type StringOrNumber = t.TypeOf<typeof StringOrNumber>;

/**
 * A numeric identifier is any valid identifier encoded as a string or number
 */
export const NumericIdentifier = new t.Type<number, StringOrNumber>(
	'NumericIdentifier',
	(i): i is number =>
		StringOrNumber.is(i) &&
		!isNaN(+i) &&
		+i === parseInt(String(i), 10) &&
		+i >= 0,
	(i, c) =>
		pipe(
			StringOrNumber.validate(i, c),
			chain((n) =>
				!isNaN(+n) && +n === parseInt(String(n), 10) && +n >= 0
					? t.success(+n)
					: t.failure(n, c, 'must be a positive integer'),
			),
		),
	Number,
);
export type NumericIdentifier = t.TypeOf<typeof NumericIdentifier>;

/**
 * Valid variable names are between 0 and 255 characters
 * and match /^[a-zA-Z_][a-zA-Z0-9_]*$/
 */
const VAR_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const VariableName = new t.Type<string, string>(
	'VariableName',
	(s: unknown): s is string => ShortString.is(s) && VAR_NAME_REGEX.test(s),
	(i, c) =>
		pipe(
			ShortString.validate(i, c),
			chain((s) =>
				VAR_NAME_REGEX.test(s)
					? t.success(s)
					: t.failure(
							s,
							c,
							"needs to start with a letter and may only contain alphanumeric characters plus '_'",
					  ),
			),
		),
	t.identity,
);
export type VariableName = t.TypeOf<typeof VariableName>;

/**
 * Valid label names are between 0 and 255 characters
 * and match /^[a-zA-Z][a-zA-Z0-9\.\-]*$/
 */
const LABEL_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9\.\-]*$/;

export const LabelName = new t.Type<string, string>(
	'LabelName',
	(s: unknown): s is string => ShortString.is(s) && LABEL_NAME_REGEX.test(s),
	(i, c) =>
		pipe(
			ShortString.validate(i, c),
			chain((s) =>
				LABEL_NAME_REGEX.test(s)
					? t.success(s)
					: t.failure(
							s,
							c,
							"needs to start with a letter and may only contain alphanumeric characters plus '-' and '.'",
					  ),
			),
		),
	t.identity,
);
export type LabelName = t.TypeOf<typeof LabelName>;

/**
 * An env var object is a dictionary with valid variables as keys
 */
export const EnvVarObject = t.record(VariableName, t.string);
export type EnvVarObject = t.TypeOf<typeof EnvVarObject>;

/**
 * An env var object is a dictionary with valid labels as keys
 */
export const LabelObject = t.record(LabelName, t.string);
export type LabelObject = t.TypeOf<typeof LabelObject>;

// Valid docker container and volume name according to
// https://github.com/moby/moby/blob/04c6f09fbdf60c7765cc4cb78883faaa9d971fa5/daemon/daemon.go#L56
// [a-zA-Z0-9][a-zA-Z0-9_.-]
const DOCKER_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_\.\-]*$/;
export const DockerName = new t.Type<string, string>(
	'DockerName',
	(s: unknown): s is string => ShortString.is(s) && DOCKER_NAME_REGEX.test(s),
	(i, c) =>
		pipe(
			ShortString.validate(i, c),
			chain((s) =>
				DOCKER_NAME_REGEX.test(s)
					? t.success(s)
					: t.failure(s, c, 'only "[a-zA-Z0-9][a-zA-Z0-9_.-]" are allowed'),
			),
		),
	t.identity,
);
export type DockerName = t.TypeOf<typeof DockerName>;

/**
 * Device name can have any characters except '\n'
 */
export const DeviceName = new t.Type<string, string>(
	'DeviceName',
	(i: unknown): i is string => ShortString.is(i) && i.indexOf('\n') === -1,
	(i, c) =>
		pipe(
			ShortString.validate(i, c),
			chain((s) =>
				s.indexOf('\n') === -1
					? t.success(s)
					: t.failure(s, c, 'must not contain newline chars'),
			),
		),
	t.identity,
);
export type DeviceName = t.TypeOf<typeof DeviceName>;

/**
 * A string boolean, one of ['true', 'false', '1', '0', 'on', 'off'].
 * Decodes to a boolean.
 */

export const BooleanFromString = new t.Type<boolean, string, unknown>(
	'BooleanFromString',
	t.boolean.is,
	(i, c) =>
		pipe(
			t.string.validate(i, c),
			chain((s) => {
				if (['true', '1', 'on'].includes(s)) {
					return t.success(true);
				}

				if (['false', '0', 'off'].includes(s)) {
					return t.success(false);
				}

				return t.failure(i, c, 'must be a valid string boolean');
			}),
		),
	String,
);
export type BooleanFromString = t.TypeOf<typeof BooleanFromString>;

/**
 * A boolean integer, one of [0, 1].
 * Decodes to a boolean.
 */
export const BooleanFromInt = new t.Type<boolean, number, unknown>(
	'BooleanFromInt',
	t.boolean.is,
	(i, c) =>
		pipe(
			t.number.validate(i, c),
			chain((n) =>
				[0, 1].includes(n)
					? t.success(Boolean(n))
					: t.failure(i, c, 'must be a valid integer boolean'),
			),
		),
	Number,
);
export type BooleanFromInt = t.TypeOf<typeof BooleanFromInt>;

/**
 * A stringified or regular boolean, one of the set of (VALID_STRING_BOOLS | [true, false] | [0, 1]).
 * Decodes to a boolean.
 *
 * TODO: replace PermissiveBoolean in src/config/types.ts
 */
export const BooleanIdentifier = new t.Type<
	boolean,
	BooleanFromString | BooleanFromInt | boolean,
	unknown
>(
	'BooleanIdentifier',
	t.boolean.is,
	(i, c) =>
		pipe(
			t.boolean.validate(i, c),
			fold(() => BooleanFromString.validate(i, c), t.success),
			fold(() => BooleanFromInt.validate(i, c), t.success),
			fold(
				() =>
					t.failure(
						i,
						c,
						'must be a valid boolean identifier of type boolean, string, or integer',
					),
				t.success,
			),
		),
	t.identity,
);
export type BooleanIdentifier = t.TypeOf<typeof BooleanIdentifier>;
