# Webnest Studio Java Playground

A Java 17 compiler and execution API with a browser practice editor. Uses the real `javac` compiler and JVM. The HTTP service uses Node.js 24 built-ins and has no npm dependencies.

**Cost policy: stay within free-tier allowances.** Local development needs no cloud services. Cloud deployment uses a paid (upgraded) billing account with a budget alert; free-tier allowances and budget alerts do not guarantee a zero bill. The Cloud Run sandbox integration must be tested in the target project before accepting students' code.

**Deployment status (2026-09-30):** the Free Trial ended and the billing account was upgraded. The target project reports `billingEnabled: true`, and its billing account reports `open: true`. A budget alert has been set in the console.

## Run locally on Windows

Node.js 24 and JDK 17 are required. This project recognizes the installed JDK at `C:\Program Files\Java\jdk-17`.

```powershell
cd D:\Playground\java-playground
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-17'
npm run dev
```

Open **http://127.0.0.1:8080**. Enter Java source, optional standard input, and click **Run code** or press **Ctrl+Enter**. Examples include input handling and an exception. Enter a full class name such as `practice.Main` if the source declares a package. One source file can contain additional non-public classes. Spring Boot is available (see below); other external libraries, multi-file Maven projects, and interactive terminal sessions are not supported.

## Spring Boot

Spring Boot **4.1.2** (Spring Framework 7) is preinstalled with the `spring-boot-starter`, `spring-boot-starter-webmvc`, and `spring-boot-starter-validation` libraries, listed in [spring-boot/pom.xml](spring-boot/pom.xml). Code that mentions `org.springframework.` is compiled and run with these jars on the classpath (`springBoot: true` in the response). Plain Java submissions are unaffected.

- Declare a package and set the class name, for example `package demo;` with `demo.Main`. `@SpringBootApplication` in the default package is rejected, because it would scan every jar.
- Limits for Spring submissions: 20 seconds compilation, 15 seconds execution, 256 MiB heap.
- The embedded web server is disabled (`spring.main.web-application-type=none`) so applications exit after their `CommandLineRunner`s. Controllers still compile. Passing `--spring.main.web-application-type=servlet` starts Tomcat, but the run then lasts until the time limit.
- Submissions have no network access, so only the listed libraries exist. To add one, add it to the pom and rebuild the image.

The Docker image resolves these jars into `/opt/spring-boot/lib` at build time using Maven 3.9.16, which is also installed (`mvn -version`). For local development, install Maven and resolve the jars, then point `SPRING_BOOT_LIB` at them (Spring tests are skipped without it):

```powershell
$mvn = 'D:\Tools\apache-maven-3.9.16\bin\mvn.cmd'
& $mvn -B -q -f spring-boot\pom.xml '-Dmaven.repo.local=D:\Tools\m2\repository' dependency:copy-dependencies -DincludeScope=runtime '-DoutputDirectory=D:\Tools\spring-boot\lib'
$env:SPRING_BOOT_LIB = 'D:\Tools\spring-boot\lib'
```

Local mode binds only to loopback and is for **trusted development code**. It is not an isolation boundary: submitted code runs under your local user account. Do not expose it through a tunnel or reverse proxy. Public student submissions must use cloud sandbox mode. Local mode is refused when the Cloud Run `K_SERVICE` variable is present.

```powershell
npm test
```

Tests run real Java 17 programs covering compiler failures, exceptions, packages, Unicode, stdin/EOF, exit codes, timeouts, output flooding, heap exhaustion, cleanup between submissions, cancellation, HTTP validation, and backpressure. Cloud lifecycle tests use a fake CLI and do **not** prove cloud isolation. CI also builds the Docker image and checks its Java executables.

## API

`GET /healthz` returns readiness and execution mode. `POST /api/run` accepts JSON:

```json
{
  "code": "public class Main { public static void main(String[] args) { System.out.println(\"Hello, Webnest!\"); } }",
  "className": "Main",
  "stdin": "",
  "args": []
}
```

`className`, `stdin`, and `args` are optional. `className` defaults to `Main`; it must match the public class and package. A successful response has this shape (timings vary):

```json
{
  "requestId": "generated-uuid",
  "status": "success",
  "phase": "run",
  "javaVersion": 17,
  "durationMs": 1250,
  "compile": {
    "stdout": "",
    "stderr": "",
    "exitCode": 0,
    "signal": null,
    "timedOut": false,
    "outputLimitExceeded": false,
    "cancelled": false,
    "durationMs": 1000
  },
  "run": {
    "stdout": "Hello, Webnest!\n",
    "stderr": "",
    "exitCode": 0,
    "signal": null,
    "timedOut": false,
    "outputLimitExceeded": false,
    "cancelled": false,
    "durationMs": 250
  }
}
```

| Status | Meaning |
| --- | --- |
| `success` | Compiled and exited with code 0 |
| `compile_error` | `compile.stderr` has compiler diagnostics and source lines; `run` is null |
| `runtime_error` | Nonzero exit; inspect `run.stderr` for stack traces and `run.stdout` for JVM messages |
| `timeout` | The phase in `phase` exceeded its deadline and was stopped |
| `output_limit` | The phase exceeded its output allowance; returned output is truncated |
| `cancelled` | The client disconnected or cancelled |

Program errors return HTTP 200 with the execution status. HTTP 400 indicates invalid JSON/input, 403 a forbidden browser origin, 413 an oversized request, 415 an incorrect content type, 429 a busy instance, and 500/503 a service problem. Every response includes `X-Request-Id`; JSON also includes `requestId`.

Limits: 64 KiB source, 16 KiB stdin, 128 KiB total request, 16 arguments of at most 1024 bytes each, 10 seconds compilation, 5 seconds execution (Spring Boot: 20 and 15 seconds), and 64 KiB combined stdout/stderr **per phase**. Standard input is sent once and closed. One active submission runs per instance; overlapping requests receive 429.

## Spring Boot projects

`POST /api/project/run` runs a multi-file Spring Boot project as a web server and sends it HTTP requests. Each call starts a fresh app with a fresh in-memory H2 database, so a client that wants data to persist replays its earlier writes.

```json
{
  "files": [{ "path": "src/main/java/com/example/demo/DemoApplication.java", "content": "..." }],
  "mainClass": "com.example.demo.DemoApplication",
  "requests": [{ "method": "POST", "path": "/api/tasks", "headers": { "Content-Type": "application/json" }, "body": "{\"title\":\"x\"}" }]
}
```

- Paths: `src/main/java/**/*.java`, plus `src/main/resources/application.properties`, `data.sql` and `schema.sql`. Up to 60 files and 256 KiB in total. `mainClass` must be in a package and match a file.
- Requests: up to 30, sent in order. Methods GET, POST, PUT, PATCH and DELETE, and paths on the app only. Bodies up to 64 KiB. Each response body is cut at 32 KiB.
- Libraries: everything in [spring-boot/project/pom.xml](spring-boot/project/pom.xml) (web, validation, Spring Data JPA and H2), resolved into `/opt/spring-boot/project-lib`. Single-file Spring runs keep the smaller [spring-boot/pom.xml](spring-boot/pom.xml) set. For local runs, resolve the project set the same way as the README shows above and set `SPRING_BOOT_PROJECT_LIB` to that folder.
- One deadline (100 seconds) covers the whole run. Readiness is checked by connecting to the port, so the app's own routes are never called before its requests.
- The runner sets the port, the H2 datasource and the servlet web server on the command line, so `application.properties` cannot change them.
- Limits: 30 seconds to compile, 45 seconds for the app to start listening, 10 seconds per request and 25 seconds for all requests.
- Result: `status` is `success`, `compile_error`, `startup_error`, `runtime_error` (the app exited while handling requests), `timeout`, `output_limit` or `cancelled`. `phase` is `compile`, `startup` or `requests`.
- Fields: `compile`, `startup` (`ready`, `ms`), `app` (the Spring log) and `responses` (`status`, `headers`, `body`, `truncated`, `ms`, and `error` when there was no answer).

Deploy it as its own service with `.\scripts\deploy.ps1 -Spring -ConfirmedPaidAccountWithBudget`. This creates `webnest-spring-playground` with 2 vCPU, 2 GiB, concurrency 1, at most 2 instances and a 120-second timeout, so long project runs never hold up single-file Java runs. Check it with `npm run test:cloud:project`, using `PLAYGROUND_URL` set to that service.

## Webnest Studio integration

```text
Webnest browser → authenticated Webnest backend → private Cloud Run playground
```

Keep the service private. The existing Webnest backend authenticates students, applies per-user rate limits and usage quotas, obtains a Google identity token for the playground URL, then forwards the request and response. Grant that backend's service account `roles/run.invoker` on this service only. Do not give Google service-account credentials to the browser. CORS is intentionally disabled; the browser calls its own backend.

The existing React/Vite frontend in `D:\WebnestSetudio\WebNestStudio` now connects through its local `/api/java/run` proxy. Start its development server and choose **Java 17 Playground** in `/codelab/playground`. The existing editor displays compiler errors, stack traces, stdout, exit status, and request IDs. See `JAVA_PLAYGROUND.md` in that repository. This integration is local; the production site cannot access this computer's JDK.

For future cloud integration, see [the backend example](examples/webnest-backend.mjs). It uses `google-auth-library`, installed in the **Webnest backend project**, and Application Default Credentials. An authenticated production proxy and invoker service account still need to be configured when cloud hosting is available.

## Docker and Cloud Run architecture

The image includes Eclipse Temurin OpenJDK 17, Node.js 24, Maven 3.9.16, and the Spring Boot 4.1.2 jars, including both `javac` and `java`. Compilation uses `--release 17`, UTF-8, and disabled annotation processing. Docker copies only the server and editor and runs the service as the unprivileged `node` user.

In cloud mode, each submission gets a new named **Cloud Run sandbox**, with compilation and execution inside it. A writable ephemeral overlay stores compiled classes. Outbound networking stays disabled, and the parent environment is not passed to submitted code. No host bind mounts or cloud credentials are provided. The parent captures stdout/stderr, enforces deadlines/output limits, and deletes the entire sandbox in `finally`, including after failures or cancellation. Cleanup failure makes the runner unhealthy and blocks further submissions. There is no unsandboxed cloud fallback.

Cloud Run sandboxes are a **Preview feature**, enabled using `gcloud beta run deploy --sandbox-launcher` in the second-generation environment. They share the instance's CPU and memory. The Java heap is capped at 128 MiB, with additional JVM limits, but this is **not** a hard per-submission total-memory or process-count limit. Deliberate resource exhaustion can still terminate the instance. Cloud Run's 1 GiB instance limit and application quotas contain usage; validate abuse cases before opening to students.

The sandbox can read the container filesystem. Do not bake secrets into the image or mount secret files in this service. Run one submission at a time, clean temporary files, and use a dedicated runtime service account with no project roles. Execute the real cloud smoke tests before production use.

Official references: [code execution and isolation](https://docs.cloud.google.com/run/docs/code-execution), [enabling service sandboxes](https://docs.cloud.google.com/run/docs/configuring/services/sandboxes), [service authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service).

## Deployment cost policy

Target project: `project-aff304a1-a183-4f95-bda`. Default region: `us-central1`.

**A zero budget does not guarantee zero charges.** Ordinary budgets are alerts. Google also offers spending caps for selected services, including Cloud Run, but enforcement can be delayed and overages remain billable. Cloud Build, image storage in Artifact Registry, and related resources have separate pricing. Scaling to zero and limiting maximum instances reduce usage but are not monetary caps.

The billing account is paid, so usage beyond the free-tier allowances is charged. To keep usage within them: at most one instance, minimum zero instances, CPU only during requests, and an Artifact Registry cleanup policy that keeps only the two newest images. Keep a budget alert under **Billing → Budgets & alerts** and review **Billing → Reports** after deploying. For a guaranteed zero cloud bill, keep execution local.

References: [budget alerts](https://docs.cloud.google.com/billing/docs/how-to/budgets), [spending-cap limits](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps), [Free Trial terms](https://cloud.google.com/signup-faqs), [Cloud Run pricing](https://cloud.google.com/run/pricing), [Cloud Build pricing](https://cloud.google.com/build/pricing), [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing).

### Deploy

Additional local tool installation and configuration stays on `D:`. Google Cloud CLI is in `D:\Tools\google-cloud-sdk`, uses existing Python in `D:\Python`, and stores configuration in `D:\Tools\gcloud-config`.

```powershell
$env:CLOUDSDK_CONFIG = 'D:\Tools\gcloud-config'
$env:CLOUDSDK_PYTHON = 'D:\Python\python.exe'
$env:TEMP = 'D:\Tools\tmp'
$env:TMP = 'D:\Tools\tmp'
$gcloud = 'D:\Tools\google-cloud-sdk\bin\gcloud.cmd'
& $gcloud auth login
```

Sign in through Google's browser flow, not by sharing passwords or keys. Use the account that owns the project (`gcloud config set account ...`).

After confirming a budget alert exists:

```powershell
.\scripts\deploy.ps1 -ConfirmedPaidAccountWithBudget
# Optionally add -WebnestServiceAccount backend@YOUR_PROJECT.iam.gserviceaccount.com
```

Without that switch, the script stops before any cloud action. The switch records the operator's confirmation; it does not verify the budget. The script never enables billing or changes the billing account. It checks billing availability, enables APIs, creates an image repository with a keep-newest-two cleanup policy and a dedicated runtime service account, builds the Docker image using Cloud Build, and deploys a private service. Required permissions include enabling APIs, building/pushing images, creating service accounts, and deploying Cloud Run. The Cloud Build service account may need additional build/Artifact Registry permissions depending on organization policy; avoid broad Owner/Editor grants.

Deployment uses 1 vCPU, 1 GiB RAM, concurrency 1, minimum 0 instances, maximum 1 instance, request-based CPU allocation, and a 60-second request timeout. Monitor billing reports after each deployment. Local Docker is not needed for Cloud Build. If Docker is available, `docker build -t webnest-java-playground .` validates the image; Cloud Run's sandbox binary is platform-provided and unavailable in ordinary local Docker.

After deployment, validate the actual backend:

```powershell
$env:PLAYGROUND_URL = & $gcloud run services describe webnest-java-playground --project=project-aff304a1-a183-4f95-bda --region=us-central1 --format='value(status.url)'
$env:PLAYGROUND_ID_TOKEN = & $gcloud auth print-identity-token
npm run test:cloud
Remove-Item Env:PLAYGROUND_ID_TOKEN
```

The signed-in account needs permission to invoke the private service. Cloud tests cover compilation, exceptions, timeout/output termination, blocked metadata/network access, environment isolation, and recovery. They consume cloud usage, which counts toward the free-tier allowances.

## Logs and troubleshooting

The editor displays stdout, compiler messages, stderr/exception stack traces, exit code, and request ID separately. Program output is rendered as text, preventing HTML injection. Stack traces retain source line numbers.

The server writes structured JSON logs with request ID, status, phase, exit codes, and duration. Infrastructure failures include their server-side error and stack. Source, input, and student output are not copied into shared Cloud Logging; inspect those in the API response. Find an execution in Logs Explorer with:

```text
resource.type="cloud_run_revision"
resource.labels.service_name="webnest-java-playground"
jsonPayload.requestId="REQUEST_ID_FROM_RESPONSE"
```

For startup failures, verify `JAVA_HOME` points to JDK **17**, not a JRE. On Cloud Run, enable the sandbox launcher and second-generation environment. Startup fails if the sandbox is unavailable. HTTP 429 means the instance is busy; retry with backoff through Webnest's backend. JVM heap failure appears as `runtime_error`; instance-level memory exhaustion can appear as a platform 5xx and must be checked in Cloud Run logs.
