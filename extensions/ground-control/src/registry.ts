import { VSCODE_HOST_ID } from '@ground-control/host-vscode';
import { makeRegistries } from '@ground-control/hub';
import type { AgentAdapter, HostAdapter } from '@ground-control/core';

/**
 * The hub's own registries, so this client reads exactly what the hub reads. Adding an agent or a host is an entry
 * in `packages/hub`, and nothing here.
 */
const registries = makeRegistries();

export const agents: readonly AgentAdapter[] = registries.agents;

/** The application this client is resident in, which is the one host it can perform a route for. */
export const host: HostAdapter = registries.hosts.find((h) => h.id === VSCODE_HOST_ID)!;
