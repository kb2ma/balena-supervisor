import { ChildProcess, spawn } from 'child_process';

import log from './supervisor-console';

function toJournalctlDate(epoch: number) {
	return new Date(epoch)
		.toISOString()
		.replace(/T/, ' ') // replace T with a space
		.replace(/\..+/, ''), // delete the dot and everything after
}

export function spawnJournalctl(opts: {
	all: boolean;
	follow: boolean;
	count?: number | 'all';
	unit?: string;
	containerId?: string;
	format: string;
	filterString?: string;
	since?: number;
	until?: number;
}): ChildProcess {
	const args: string[] = [];
	if (opts.all) {
		args.push('-a');
	}
	if (opts.follow) {
		args.push('--follow');
	}
	if (opts.unit != null) {
		args.push('-u');
		args.push(opts.unit);
	}
	if (opts.containerId != null) {
		args.push('-t');
		args.push(opts.containerId);
	}
	if (opts.count != null) {
		args.push('-n');
		args.push(opts.count.toString());
	}
	if (opts.since != null) {
		args.push('-S');
		args.push(
			toJournalctlDate(opts.since)
		);
	}
	if (opts.until != null) {
		args.push('-U');
		args.push(
			toJournalctlDate(opts.until)
		);
	}
	args.push('-o');
	args.push(opts.format);

	if (opts.filterString) {
		args.push(opts.filterString);
	}

	log.debug('Spawning journalctl', args.join(' '));

	const journald = spawn('journalctl', args, {
		stdio: 'pipe',
	});

	return journald;
}
