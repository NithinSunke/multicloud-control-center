export async function verifyGithubConnector(connector) {
  if (!connector.githubToken) {
    return { ok: false, message: 'GitHub token is missing.' };
  }

  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${connector.githubToken}`,
        'User-Agent': 'MC3-Proxmox-Manager',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) {
      return { ok: false, message: `GitHub verification failed with HTTP ${response.status}.` };
    }
    const data = await response.json();
    return {
      ok: true,
      message: `Connected to GitHub as ${data.login || connector.githubUsername}.`,
      githubUsername: data.login || connector.githubUsername,
    };
  } catch (error) {
    return { ok: false, message: `GitHub verification failed: ${error.message}` };
  }
}
