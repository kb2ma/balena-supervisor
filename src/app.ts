/**
 * Entry point for Supervisor application. Supervisor is factored into many modules.
 * The diagram and table below guides you to these internals.
 *
 * [[include:supervisor-arch.svg]]
 *
 * | Module/Folder | Context / Description |
 * | ------------- | ----------- |
 * | [supervisor](supervisor.html) | Initialization for Supervisor application modules |
 * | api-binder folder | Implements HTTP interface to balena cloud API |
 * | [application-manager](compose_application_manager.html) | Directs imageManager and creates steps for state transitions |
 * | config folder | Interface and definitions for configuration data |
 * | [db](db.html) | Storage for Supervisor state |
 * | device-api folder | Provides endpoints for Supervisor HTTP API |
 * | [device-config](device-config.html) | Access to device configuration and steps to change it |
 * | [device-state](device-state.html) | Application level access to device state, checks, reports, events |
 * | [logger](logger.html) | Application interface for logging |
 * | logging folder | Contains logging implementations |
 * | [supervisor-api](supervisor-api.html) | Server for Supervisor HTTP API |
 * | [supervisor-console](lib_supervisor_console.html) | Prints log messages to stdout |
 * | [](.html) | |
 *
 * @module
 */
import { set } from '@balena/es-version';
// Set the desired es version for downstream modules that support it, before we import any
set('es2022');

import { setDefaultAutoSelectFamilyAttemptTimeout } from 'net';
// Increase the timeout for the happy eyeballs algorithm to 5000ms to avoid issues on slower networks
setDefaultAutoSelectFamilyAttemptTimeout(5000);

// Setup MDNS resolution
import './mdns';

import Supervisor from './supervisor';
import process from 'process';
import log from './lib/supervisor-console';

// Register signal handlers before starting the supervisor service
process.on('SIGTERM', () => {
	log.info('Received SIGTERM. Exiting.');

	// This is standard exit code to indicate a graceful shutdown
	// it equals 128 + 15 (the signal code)
	process.exit(143);
});

const supervisor = new Supervisor();
supervisor.init().catch((e) => {
	log.error('Uncaught exception:', e);

	// Terminate the process to avoid leaving the supervisor in a bad state
	process.exit(1);
});
