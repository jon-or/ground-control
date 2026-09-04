/** Replaced by the bundler that embeds the hub in a client. A source-tree run has no bundler, so it is unversioned. */
declare const __GC_VERSION__: string | undefined;

export const VERSION = typeof __GC_VERSION__ === 'string' ? __GC_VERSION__ : '0.0.0';
