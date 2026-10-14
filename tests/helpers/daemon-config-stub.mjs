const config = {
  daemonPort: Number(process.env.DAEMON_TEST_PORT),
  daemonTTL: Number(process.env.DAEMON_TEST_TTL_MS || 40),
  sessionLeaseMs: Number(process.env.DAEMON_TEST_LEASE_MS || 180),
  sessionLeaseWaitMs: Number(process.env.DAEMON_TEST_WAIT_MS || 1000),
  browserDebugPort: 0,
  browserHeadless: true,
  browserProtocolTimeout: 1000,
};

export default config;
