import { VSCODE_HOST_ID } from '@ground-control/host-vscode';
import { makeRegistries } from '@ground-control/hub';
import type { HostAdapter } from '@ground-control/core';
import type { Registries } from '@ground-control/hub';

/** Reuse hub registries so adding agents or hosts requires no client registration. */
export const registries: Registries = makeRegistries();

/** The application this client is resident in, which is the one host it can perform a route for. */
export const host: HostAdapter = registries.hosts.find((h) => h.id === VSCODE_HOST_ID)!;
