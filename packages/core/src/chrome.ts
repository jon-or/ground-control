/**
 * The browser overlay's identity, fixed by the public key in its manifest. Chrome derives an unpacked extension's id
 * from that key, so the id a native-messaging host allows stays the same wherever the extension is loaded from.
 */
export const CHROME_EXTENSION_ID = 'jmokhilledjhchaflaabojnfojefmdnh';

/** The name Chrome looks the native host up by, in the registry on Windows and in a profile directory elsewhere. */
export const NATIVE_HOST_NAME = 'com.ownerrez.ground_control';
