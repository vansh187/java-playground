const $ = id => document.getElementById(id);
const examples = {
  hello: `public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, Webnest Studio!");

        for (int i = 1; i <= 5; i++) {
            System.out.println("Keep learning. Step " + i);
        }
    }
}`,
  input: `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner scanner = new Scanner(System.in);
        String name = scanner.nextLine();
        System.out.println("Welcome, " + name + "!");
    }
}`,
  exception: `public class Main {
    public static void main(String[] args) {
        System.out.println("Let's explore a stack trace.");
        int[] numbers = {10, 20, 30};
        System.out.println(numbers[5]);
    }
}`,
  spring: `package demo;

import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.stereotype.Service;

@SpringBootApplication
public class Main {
    public static void main(String[] args) {
        SpringApplication.run(Main.class, args);
    }

    @Bean
    CommandLineRunner start(GreetingService greetings) {
        return args -> System.out.println(greetings.greet("Webnest learner"));
    }
}

@Service
class GreetingService {
    String greet(String name) {
        return "Hello, " + name + "! Spring injected this service.";
    }
}`,
};
$('code').value = examples.hello;
$('example').addEventListener('change', () => {
  $('code').value = examples[$('example').value];
  $('className').value = $('example').value === 'spring' ? 'demo.Main' : 'Main';
  $('stdin').value = $('example').value === 'input' ? 'Java learner\n' : '';
});
$('code').addEventListener('keydown', event => {
  if (event.key === 'Tab') {
    event.preventDefault();
    const field = event.target;
    field.setRangeText('    ', field.selectionStart, field.selectionEnd, 'end');
  }
});
function output(label, text, isError = false) {
  if (!text) return;
  const heading = document.createElement('p');
  heading.className = 'output-label';
  heading.textContent = label;
  const pre = document.createElement('pre');
  pre.textContent = text; // Submitted programs cannot inject HTML into the editor.
  if (isError) pre.className = 'error';
  $('results').append(heading, pre);
}
async function run() {
  if ($('run').disabled) return;
  $('run').disabled = true;
  $('status').textContent = 'Compiling & running…';
  $('results').replaceChildren();
  $('requestId').textContent = '';
  try {
    const response = await fetch('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: $('code').value, className: $('className').value.trim(), stdin: $('stdin').value }),
      signal: AbortSignal.timeout(60000), // Spring Boot runs may take up to ~55 s in the worst case.
    });
    const data = await response.json();
    $('requestId').textContent = `Request: ${data.requestId || 'unavailable'}`;
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    $('status').textContent = `${data.status.replaceAll('_', ' ')} · ${data.durationMs} ms`;
    output('COMPILER OUTPUT', data.compile.stdout);
    output('COMPILER MESSAGES', data.compile.stderr, data.status === 'compile_error');
    output('STANDARD OUTPUT', data.run?.stdout);
    output('STANDARD ERROR / EXCEPTION', data.run?.stderr, true);
    if (data.status === 'timeout') output('TIME LIMIT', `${data.phase === 'compile' ? 'Compilation' : 'Your program'} exceeded its time limit and was stopped.`, true);
    if (data.status === 'output_limit') output('OUTPUT LIMIT', 'Execution stopped after 64 KiB of output. The output above is truncated.', true);
    if (data.status === 'success' && !data.run.stdout && !data.run.stderr) output('FINISHED', 'Your program completed without printing output.');
    if (data.run) output('EXIT CODE', String(data.run.exitCode ?? data.run.signal ?? 'stopped'));
  } catch (error) {
    $('status').textContent = 'Unable to run';
    output('REQUEST ERROR', error.message, true);
  } finally { $('run').disabled = false; }
}
$('run').addEventListener('click', run);
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); run(); }
});
fetch('/healthz').then(r => { if (!r.ok) throw new Error('Unhealthy'); return r.json(); }).then(data => {
  $('runtime').textContent = data.executionMode === 'local' ? '● Local JDK 17 · trusted code only' : '● Java 17 · Cloud Run sandbox';
}).catch(() => { $('runtime').textContent = 'Execution service unavailable'; });
