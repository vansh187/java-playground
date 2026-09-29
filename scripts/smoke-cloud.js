import assert from 'node:assert/strict';

const base = process.env.PLAYGROUND_URL?.replace(/\/$/, '');
const token = process.env.PLAYGROUND_ID_TOKEN;
if (!base || !token) throw new Error('Set PLAYGROUND_URL and PLAYGROUND_ID_TOKEN (a Google identity token)');
const program = body => `public class Main { public static void main(String[] args) throws Exception { ${body} } }`;
async function run(code) {
  const response = await fetch(`${base}/api/run`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }), signal: AbortSignal.timeout(55000),
  });
  assert.equal(response.status, 200, `HTTP ${response.status}: ${await response.clone().text()}`);
  return response.json();
}
const success = await run(program('System.out.println("cloud works");'));
assert.equal(success.status, 'success');
assert.equal(success.run.stdout.trim(), 'cloud works');
assert.equal((await run(program('invalid java'))).status, 'compile_error');
const exception = await run(program('throw new IllegalStateException("visible exception");'));
assert.equal(exception.status, 'runtime_error');
assert.match(exception.run.stderr, /visible exception/);
assert.equal((await run(program('while(true) {}'))).status, 'timeout');
assert.equal((await run(program('while(true) System.out.print("xxxxxxxxxx");'))).status, 'output_limit');
// Metadata and external network must not be reachable from submitted code.
for (const target of ['http://169.254.169.254/computeMetadata/v1/', 'https://example.com']) {
  const result = await run(program(`try { var c = new java.net.URL("${target}").openConnection(); c.setConnectTimeout(1500); c.setReadTimeout(1500); c.setRequestProperty("Metadata-Flavor", "Google"); c.getInputStream().close(); System.out.print("REACHABLE"); } catch (java.io.IOException e) { System.out.print("BLOCKED"); }`));
  assert.equal(result.status, 'success');
  assert.equal(result.run.stdout, 'BLOCKED', `Network isolation failed for ${target}`);
}
const environment = await run(program('System.out.print(System.getenv("K_SERVICE"));'));
assert.equal(environment.run.stdout, 'null');
assert.equal((await run(program('System.out.print("healthy after limits");'))).status, 'success');
console.log('Cloud smoke tests passed: compilation, exceptions, deadlines, output limits, network/metadata isolation, environment, and recovery.');
