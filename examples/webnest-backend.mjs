// Integrate this function into your EXISTING authenticated Webnest backend route.
// Install google-auth-library in that backend, not in the playground service.
// The caller must verify the student's session and enforce per-user quotas first.
import { GoogleAuth } from 'google-auth-library';

const audience = process.env.JAVA_PLAYGROUND_URL?.replace(/\/$/, '');
if (!audience) throw new Error('Set JAVA_PLAYGROUND_URL to the private Cloud Run URL');
const auth = new GoogleAuth();
const client = await auth.getIdTokenClient(audience);

export async function executeJava({ code, className = 'Main', stdin = '', args = [] }) {
  const response = await client.request({
    url: `${audience}/api/run`,
    method: 'POST',
    data: { code, className, stdin, args },
    timeout: 55000,
    retry: false,
  });
  return response.data;
}
