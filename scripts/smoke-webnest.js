import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:5173';
const post = (code, extra = {}, options = {}) => fetch(`${base}/api/java/run`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...options.headers },
  body: JSON.stringify({ code, ...extra }), signal: options.signal,
});
const program = body => `public class Main { public static void main(String[] args) throws Exception { ${body} } }`;
const success = await post(program('System.out.println("Webnest frontend connected");'));
assert.equal(success.status, 200);
assert.equal((await success.json()).run.stdout.trim(), 'Webnest frontend connected');
console.log('PASS: frontend proxy → javac → JVM → response');
const input = await (await post(program('System.out.print(new java.util.Scanner(System.in).nextLine());'), { stdin: 'input from frontend\n' })).json();
assert.equal(input.run.stdout, 'input from frontend');
console.log('PASS: frontend standard input');
const compile = await (await post(program('invalid java'))).json();
assert.equal(compile.status, 'compile_error');
assert.match(compile.compile.stderr, /Main.java:1/);
console.log('PASS: frontend compiler diagnostics');
const exception = await (await post(program('throw new IllegalStateException("frontend trace");'))).json();
assert.equal(exception.status, 'runtime_error');
assert.match(exception.run.stderr, /frontend trace/);
console.log('PASS: frontend exception stack trace');
assert.equal((await post(program(''), {}, { headers: { Origin: 'https://untrusted.example' } })).status, 404);
console.log('PASS: foreign browser origin rejected by proxy');
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 1600);
await assert.rejects(post(program('while (true) {}'), {}, { signal: controller.signal }), /abort/i);
clearTimeout(timer);
let recovered = false;
for (let attempt = 0; attempt < 12; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 150));
  const next = await post(program('System.out.print("after stop");'));
  if (next.status === 429) continue;
  assert.equal(next.status, 200);
  assert.equal((await next.json()).run.stdout, 'after stop');
  recovered = true;
  break;
}
assert.ok(recovered, 'Stop must cancel upstream execution promptly');
console.log('PASS: frontend Stop aborts upstream execution; next run succeeds');
