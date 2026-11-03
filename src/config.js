import path from 'node:path';

export function configuration(env = process.env) {
  const mode = env.EXECUTION_MODE || 'cloud-run';
  if (!['local', 'cloud-run'].includes(mode)) throw new Error('EXECUTION_MODE must be local or cloud-run');
  if (mode === 'local' && env.K_SERVICE) throw new Error('Local execution is forbidden on Cloud Run');
  const javaHome = env.JAVA_HOME;
  if (!javaHome) throw new Error('Set JAVA_HOME to a JDK 17 installation');
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  return {
    mode, port, host: mode === 'local' ? '127.0.0.1' : '0.0.0.0',
    java: path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
    javac: path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'),
    sandbox: '/usr/local/gcp/bin/sandbox',
    // Jars resolved from spring-boot/pom.xml at image build time; used only when a submission imports Spring.
    springBootLib: env.SPRING_BOOT_LIB || '/opt/spring-boot/lib',
    compileTimeoutMs: 10000, runTimeoutMs: 5000, outputLimitBytes: 65536,
    // Spring Boot needs more time and memory to compile against its jars and start its context.
    springCompileTimeoutMs: 20000, springRunTimeoutMs: 15000,
    bodyLimitBytes: 131072, codeLimitBytes: 65536, stdinLimitBytes: 16384,
  };
}
