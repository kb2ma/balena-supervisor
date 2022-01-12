import { expect } from 'chai';
import { isRight } from 'fp-ts/lib/Either';

import { BooleanIdentifier } from '../../../src/types';

describe('BooleanIdentifier', () => {
	const decodeResultAccumulator = (accumulator: boolean, input: any) =>
		accumulator && isRight(BooleanIdentifier.decode(input));

	it('should decode valid string booleans', () => {
		const valid = ['true', '1', 'on', 'false', '0', 'off'];
		const invalid = ['', 'right', 'wrong'];

		expect((valid as any).reduce(decodeResultAccumulator, true)).to.be.true;
		expect((invalid as any).reduce(decodeResultAccumulator, false)).to.be.false;
	});

	it('should decode valid integer booleans', () => {
		const valid = [0, 1];
		const invalid = [-1, 10];

		expect((valid as any).reduce(decodeResultAccumulator, true)).to.be.true;
		expect((invalid as any).reduce(decodeResultAccumulator, false)).to.be.false;
	});

	it('should decode valid booleans', () => {
		const valid = [true];
		const invalid = [false];

		expect((valid as any).reduce(decodeResultAccumulator, true)).to.be.true;
		expect((invalid as any).reduce(decodeResultAccumulator, false)).to.be.false;
	});
});
