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

Open **http://127.0.0.1:8080**. Enter Java source, optional standard input, and click **Run code** or press **Ctrl+Enter**. Examples include input handling and an exception. Enter a full class name such as `practice.Main` if the source declares a package. One source file can contain additional non-public classes. External libraries, Maven projects, and interactive terminal sessions are not supported.

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

Limits: 64 KiB source, 16 KiB stdin, 128 KiB total request, 16 arguments of at most 1024 bytes each, 10 seconds compilation, 5 seconds execution, and 64 KiB combined stdout/stderr **per phase**. Standard input is sent once and closed. One active submission runs per instance; overlapping requests receive 429.

## Webnest Studio integration

```text
Webnest browser → authenticated Webnest backend → private Cloud Run playground
```

Keep the service private. The existing Webnest backend authenticates students, applies per-user rate limits and usage quotas, obtains a Google identity token for the playground URL, then forwards the request and response. Grant that backend's service account `roles/run.invoker` on this service only. Do not give Google service-account credentials to the browser. CORS is intentionally disabled; the browser calls its own backend.

The existing React/Vite frontend in `D:\WebnestSetudio\WebNestStudio` now connects through its local `/api/java/run` proxy. Start its development server and choose **Java 17 Playground** in `/codelab/playground`. The existing editor displays compiler errors, stack traces, stdout, exit status, and request IDs. See `JAVA_PLAYGROUND.md` in that repository. This integration is local; the production site cannot access this computer's JDK.

For future cloud integration, see [the backend example](examples/webnest-backend.mjs). It uses `google-auth-library`, installed in the **Webnest backend project**, and Application Default Credentials. An authenticated production proxy and invoker service account still need to be configured when cloud hosting is available.

## Docker and Cloud Run architecture

The image includes Eclipse Temurin OpenJDK 17 and Node.js 24, including both `javac` and `java`. Compilation uses `--release 17`, UTF-8, and disabled annotation processing. Docker copies only the server and editor and runs the service as the unprivileged `node` user.

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
