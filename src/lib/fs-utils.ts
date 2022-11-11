import _ from 'lodash';
import { promises as fs } from 'fs';
import * as path from 'path';
import { exec as execSync } from 'child_process';
import { promisify } from 'util';
import { uptime } from 'os';

import * as constants from './constants';

export const exec = promisify(execSync);

export async function writeAndSyncFile(
	pathName: string,
	data: string | Buffer,
): Promise<void> {
	const file = await fs.open(pathName, 'w');
	if (typeof data === 'string') {
		await file.write(data, 0, 'utf8');
	} else {
		await file.write(data, 0, data.length);
	}
	await file.sync();
	await file.close();
}

export async function writeFileAtomic(
	pathName: string,
	data: string | Buffer,
): Promise<void> {
	await writeAndSyncFile(`${pathName}.new`, data);
	await safeRename(`${pathName}.new`, pathName);
}

export async function safeRename(src: string, dest: string): Promise<void> {
	await fs.rename(src, dest);
	const file = await fs.open(path.dirname(dest), 'r');
	await file.sync();
	await file.close();
}

export async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if a path exists as a direct child of the device's root mountpoint,
 * which is equal to constants.rootMountPoint (`/mnt/root`).
 */
export function pathExistsOnHost(pathName: string): Promise<boolean> {
	return exists(path.join(constants.rootMountPoint, pathName));
}

/**
 * Recursively create directories until input directory.
 * Equivalent to mkdirp package, which uses this under the hood.
 */
export async function mkdirp(pathName: string): Promise<void> {
	await fs.mkdir(pathName, { recursive: true });
}

/**
 * Safe unlink with built-in catch for invalid paths, to remove need
 * for catch implementation everywhere else unlink is needed.
 */
export async function unlinkAll(...paths: string[]): Promise<void> {
	await Promise.all(
		paths.map((pathName) =>
			fs.unlink(pathName).catch(() => {
				/* Ignore nonexistent paths */
			}),
		),
	);
}

/**
 * Get one or more paths as they exist in relation to host OS's root.
 */
export function getPathOnHost(path: string): string;
export function getPathOnHost(...paths: string[]): string[];
export function getPathOnHost(...paths: string[]): string[] | string {
	if (paths.length === 1) {
		return path.join(constants.rootMountPoint, paths[0]);
	} else {
		return paths.map((p: string) => path.join(constants.rootMountPoint, p));
	}
}

/**
 * Change modification and access time of the given file.
 * It creates an empty file if it does not exist
 */
export const touch = (file: string, time = new Date()) =>
	// set both access time and modified time to the value passed
	// as argument (default to `now`)
	fs.utimes(file, time, time).catch((e) =>
		// only create the file if it doesn't exist,
		// if some other error happens is probably better to not touch it
		e.code === 'ENOENT'
			? fs
					.open(file, 'w')
					.then((fd) => fd.close())
					// If date is custom we need to change the file atime and mtime
					.then(() => fs.utimes(file, time, time))
			: e,
	);

// Get the system boot time as a Date object
export const getBootTime = () =>
	new Date(new Date().getTime() - uptime() * 1000);
