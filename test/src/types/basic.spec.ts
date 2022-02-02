import { expect } from 'chai';
import * as t from 'io-ts';
import { isRight } from 'fp-ts/lib/Either';

import { withDefault, GenericBoolean } from '../../../src/types';

describe('types/basic', () => {
	describe('withDefault', () => {
		it('should set a default if a value to be decoded is null or undefined', () => {
			const tests = [
				{
					type: t.boolean,
					defaultVal: true,
					right: false,
					left: 'true',
				},
				{
					type: t.number,
					defaultVal: 1,
					right: 10,
					left: '10',
				},
				{
					type: t.string,
					defaultVal: 'abc',
					right: 'def',
					left: 10,
				},
				{
					type: t.record(t.string, t.number),
					defaultVal: {},
					right: { test: 123 },
					left: { test: 'abc' },
				},
				{
					type: t.array(t.number),
					defaultVal: [],
					right: [1, 2],
					left: ['a', 'b'],
				},
			];

			tests.forEach(({ type, defaultVal, right, left }) => {
				const TypeWithDefault = withDefault(type, defaultVal);
				const shouldDefault = [
					TypeWithDefault.decode(undefined),
					TypeWithDefault.decode(null),
				];
				shouldDefault.forEach((decoded) => {
					expect(isRight(decoded)).to.be.true;
					// @ts-ignore
					expect(decoded.right).to.equal(defaultVal);
				});

				const shouldLeft = TypeWithDefault.decode(left);
				expect(isRight(shouldLeft)).to.be.false;

				const shouldRight = TypeWithDefault.decode(right);
				expect(isRight(shouldRight)).to.be.true;
				// @ts-ignore
				expect(shouldRight.right).to.equal(right);
			});
		});

		it('should set a default based on a custom default function if provided', () => {
			const tests = [
				{
					type: t.string,
					defaultVal: 'abc',
					right: 'def',
					left: 123,
					willDefault: '',
					shouldDefaultFn: (val: any) => t.string.is(val) && val.length === 0,
				},
				{
					type: t.number,
					defaultVal: 10,
					right: 6,
					left: '5',
					willDefault: 1,
					shouldDefaultFn: (val: any) => t.number.is(val) && val < 5,
				},
				{
					type: t.array(t.number),
					defaultVal: [1],
					right: [1, 2],
					left: ['abc'],
					willDefault: [false],
					shouldDefaultFn: (val: any) =>
						val.some((unit: any) =>
							['false', 'true'].includes(unit.toString()),
						),
				},
			];

			tests.forEach(
				({ type, defaultVal, right, left, willDefault, shouldDefaultFn }) => {
					const TypeWithDefault = withDefault(
						type,
						defaultVal,
						shouldDefaultFn,
					);

					const shouldDefault = TypeWithDefault.decode(willDefault);
					expect(isRight(shouldDefault)).to.be.true;
					// @ts-ignore
					expect(shouldDefault.right).to.equal(defaultVal);

					const shouldLeft = TypeWithDefault.decode(left);
					expect(isRight(shouldLeft)).to.be.false;

					const shouldRight = TypeWithDefault.decode(right);
					expect(isRight(shouldRight)).to.be.true;
					// @ts-ignore
					expect(shouldRight.right).to.equal(right);
				},
			);
		});

		it('should allow the result of a promise as a default value', async () => {
			const getPromisedNum = async (num: number): Promise<number> =>
				new Promise((resolve) => resolve(num));

			const TypeWithPromiseDefault = withDefault(
				t.number,
				await getPromisedNum(101),
			);

			const decoded = TypeWithPromiseDefault.decode(undefined);
			expect(isRight(decoded)).to.be.true;
			// @ts-ignore
			expect(decoded.right).to.equal(101);
		});
	});

	describe('GenericBoolean', () => {
		const decodeResultAccumulator = (accumulator: boolean, input: any) =>
			accumulator && isRight(GenericBoolean.decode(input));

		it('should decode valid string booleans', () => {
			const valid = ['true', '1', 'on', 'false', '0', 'off'];
			const invalid = ['', 'right', 'wrong'];

			expect((valid as any).reduce(decodeResultAccumulator, true)).to.be.true;
			expect((invalid as any).reduce(decodeResultAccumulator, false)).to.be
				.false;
		});

		it('should decode valid integer booleans', () => {
			const valid = [0, 1];
			const invalid = [-1, 10];

			expect((valid as any).reduce(decodeResultAccumulator, true)).to.be.true;
			expect((invalid as any).reduce(decodeResultAccumulator, false)).to.be
				.false;
		});

		it('should decode valid booleans', () => {
			const valid = [true];
			const invalid = [false];

			expect((valid as any).reduce(decodeResultAccumulator, true)).to.be.true;
			expect((invalid as any).reduce(decodeResultAccumulator, false)).to.be
				.false;
		});
	});
});
