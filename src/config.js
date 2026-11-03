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
    // Project runs only: the same plus JPA and H2 (spring-boot/project/pom.xml).
    springBootProjectLib: env.SPRING_BOOT_PROJECT_LIB || '/opt/spring-boot/project-lib',
    compileTimeoutMs: 10000, runTimeoutMs: 5000, outputLimitBytes: 65536,
    // Spring Boot needs more time and memory to compile against its jars and start its context.
    springCompileTimeoutMs: 20000, springRunTimeoutMs: 15000,
    // Spring Boot projects (POST /api/project/run): compiled, started as a web server, sent requests.
    projectBodyLimitBytes: 524288, projectCodeLimitBytes: 262144, projectFileLimit: 60,
    projectRequestLimit: 30, projectRequestBodyLimitBytes: 65536, projectResponseBodyLimitBytes: 32768,
    projectProbeOutputLimitBytes: 1048576,
    projectCompileTimeoutMs: 30000, projectReadyTimeoutMs: 45000,
    projectRequestTimeoutMs: 10000, projectRequestsTimeoutMs: 25000,
    projectAppTimeoutMs: 80000,
    // One deadline for a whole project run, so every stage together stays inside the sandbox's
    // lifetime, the backend's timeout (115 s) and Cloud Run's request timeout (120 s).
    projectTotalTimeoutMs: 100000, projectSandboxLifetimeMs: 110000,
    projectHeapMb: Number(env.PROJECT_HEAP_MB || 384), projectCpus: Number(env.PROJECT_CPUS || 2),
    bodyLimitBytes: 131072, codeLimitBytes: 65536, stdinLimitBytes: 16384,
  };
}
