/**
 * Cloudflare Email Worker — Email-to-Publish for Create Revenue
 *
 * Flow:
 * 1. Brendan emails publish@createrevenue.com
 * 2. Worker validates sender, extracts content
 * 3. Calls Claude API to convert email body → Markdown with frontmatter
 * 4. Commits to `staging` branch via GitHub API
 * 5. Emails Brendan a preview URL
 * 6. Brendan replies OK → Worker cherry-picks to `main` → live
 * 7. Brendan replies with edits → Worker re-processes → new staging commit
 */

// ─── Configuration ───────────────────────────────────────────────
const CONFIG = {
  // Allowed senders (whitelist)
  allowedSenders: ['brendan@createrevenue.com'], // Add Brendan's actual email(s)

  // GitHub
  githubOwner: 'franckj',
  githubRepo: 'createrevenue-site',
  githubBranch: 'staging',
  githubMainBranch: 'main',

  // Claude API
  claudeModel: 'claude-haiku-4-5-20251001',

  // Email
  fromEmail: 'publish@createrevenue.com',
  replyPrefix: 'approve',        // approve+{slug}@createrevenue.com

  // Site
  previewBaseUrl: 'https://staging.createrevenue-site.pages.dev',
  productionBaseUrl: 'https://createrevenue.com',
};

// ─── Email Handler ───────────────────────────────────────────────
export default {
  async email(message, env, ctx) {
    const sender = message.from;
    const to = message.to;
    const subject = message.headers.get('subject') || '';

    // Validate sender
    if (!CONFIG.allowedSenders.includes(sender.toLowerCase())) {
      console.log(`Rejected email from unauthorized sender: ${sender}`);
      message.setReject('Unauthorized sender');
      return;
    }

    // Determine if this is a new post or an approval/edit reply
    if (to.startsWith(`${CONFIG.replyPrefix}+`)) {
      // This is a reply to a preview email
      const slug = extractSlugFromAddress(to);
      const body = await streamToText(message.raw);
      const emailBody = extractEmailBody(body);

      if (isApproval(emailBody)) {
        await handleApproval(slug, env);
        await sendEmail(env, sender, `Published: ${slug}`,
          `Your post is live at ${CONFIG.productionBaseUrl}/blog/${slug}/`
        );
      } else {
        // Treat reply as corrections
        await handleCorrections(slug, emailBody, env);
        await sendEmail(env, sender, `Updated preview: ${slug}`,
          `Updated preview ready: ${CONFIG.previewBaseUrl}/blog/${slug}/\n\nReply OK to publish, or reply with more edits.`
        );
      }
    } else if (to.startsWith('publish@')) {
      // New post submission
      const body = await streamToText(message.raw);
      const emailBody = extractEmailBody(body);

      const { slug, markdown } = await processNewPost(subject, emailBody, env);
      await commitToStaging(slug, markdown, env);

      await sendEmail(env, sender, `Preview ready: ${subject}`,
        `Your post is staged for preview:\n\n${CONFIG.previewBaseUrl}/blog/${slug}/\n\nReply OK to publish, or reply with corrections.`,
        `${CONFIG.replyPrefix}+${slug}@createrevenue.com`
      );
    }
  },

  // Also handle HTTP requests for health checks
  async fetch(request, env) {
    return new Response('Email Worker is running.', { status: 200 });
  },
};

// ─── Core Functions ──────────────────────────────────────────────

/**
 * Process a new post: call Claude to convert email body to Markdown
 */
async function processNewPost(subject, body, env) {
  const slug = slugify(subject);
  const today = new Date().toISOString().split('T')[0];

  const prompt = `Convert this email into a blog post in Markdown format for an Astro content collection.

Return ONLY the complete file content, starting with the frontmatter delimiters (---).

Frontmatter must include:
- title: Use the email subject: "${subject}"
- description: Write a compelling 1-sentence description (under 160 characters)
- pubDate: ${today}
- tags: Extract 2-4 relevant tags as an array

Rules:
- Keep the author's voice and tone intact — do not make it more formal or corporate
- Fix obvious typos and grammar issues
- Structure with clear headings (h2, h3) where natural
- Do not add content that wasn't in the original email
- Do not add a title heading (h1) — the layout handles that

Email body:
${body}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CONFIG.claudeModel,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  const markdown = data.content[0].text;

  return { slug, markdown };
}

/**
 * Commit a blog post to the staging branch via GitHub API
 */
async function commitToStaging(slug, content, env) {
  const path = `src/content/blog/${slug}.md`;

  // Get the current staging branch ref (or create it from main)
  let stagingRef;
  try {
    stagingRef = await githubAPI(`git/ref/heads/${CONFIG.githubBranch}`, 'GET', null, env);
  } catch {
    // Staging branch doesn't exist — create from main
    const mainRef = await githubAPI(`git/ref/heads/${CONFIG.githubMainBranch}`, 'GET', null, env);
    stagingRef = await githubAPI('git/refs', 'POST', {
      ref: `refs/heads/${CONFIG.githubBranch}`,
      sha: mainRef.object.sha,
    }, env);
  }

  const sha = stagingRef.object?.sha || stagingRef.object?.sha;

  // Create blob
  const blob = await githubAPI('git/blobs', 'POST', {
    content: content,
    encoding: 'utf-8',
  }, env);

  // Get current tree
  const commit = await githubAPI(`git/commits/${sha}`, 'GET', null, env);

  // Create new tree with the blog post
  const tree = await githubAPI('git/trees', 'POST', {
    base_tree: commit.tree.sha,
    tree: [{
      path: path,
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    }],
  }, env);

  // Create commit
  const newCommit = await githubAPI('git/commits', 'POST', {
    message: `Add blog post: ${slug}`,
    tree: tree.sha,
    parents: [sha],
  }, env);

  // Update staging ref
  await githubAPI(`git/refs/heads/${CONFIG.githubBranch}`, 'PATCH', {
    sha: newCommit.sha,
  }, env);
}

/**
 * Handle approval: merge the specific post from staging to main
 */
async function handleApproval(slug, env) {
  const path = `src/content/blog/${slug}.md`;

  // Get file content from staging
  const file = await githubAPI(
    `contents/${path}?ref=${CONFIG.githubBranch}`,
    'GET', null, env
  );

  // Create or update the file on main
  let existingSha;
  try {
    const existing = await githubAPI(
      `contents/${path}?ref=${CONFIG.githubMainBranch}`,
      'GET', null, env
    );
    existingSha = existing.sha;
  } catch {
    // File doesn't exist on main yet — that's fine
  }

  await githubAPI(`contents/${path}`, 'PUT', {
    message: `Publish blog post: ${slug}`,
    content: file.content, // Already base64 from GitHub API
    branch: CONFIG.githubMainBranch,
    ...(existingSha && { sha: existingSha }),
  }, env);
}

/**
 * Handle corrections: re-process with Claude and update staging
 */
async function handleCorrections(slug, corrections, env) {
  const path = `src/content/blog/${slug}.md`;

  // Get current content from staging
  const file = await githubAPI(
    `contents/${path}?ref=${CONFIG.githubBranch}`,
    'GET', null, env
  );
  const currentContent = atob(file.content);

  const prompt = `Here is a blog post that needs corrections based on author feedback.

Current post:
${currentContent}

Author's corrections/edits:
${corrections}

Return the COMPLETE updated Markdown file (including frontmatter). Apply the corrections while keeping the overall structure and voice intact. Return ONLY the file content, nothing else.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CONFIG.claudeModel,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  const updatedMarkdown = data.content[0].text;

  // Commit updated version to staging
  await commitToStaging(slug, updatedMarkdown, env);
}

// ─── Helpers ─────────────────────────────────────────────────────

async function githubAPI(endpoint, method, body, env) {
  const url = `https://api.github.com/repos/${CONFIG.githubOwner}/${CONFIG.githubRepo}/${endpoint}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'createrevenue-email-worker',
      ...(body && { 'Content-Type': 'application/json' }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error (${response.status}): ${error}`);
  }

  return response.json();
}

async function sendEmail(env, to, subject, body, replyTo) {
  // Using Cloudflare's MailChannels integration or Postmark
  // This is a simplified version — replace with actual email sending
  const emailPayload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: CONFIG.fromEmail, name: 'Create Revenue' },
    subject: subject,
    content: [{ type: 'text/plain', value: body }],
    ...(replyTo && { reply_to: { email: replyTo } }),
  };

  // If using Postmark:
  if (env.POSTMARK_TOKEN) {
    await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': env.POSTMARK_TOKEN,
      },
      body: JSON.stringify({
        From: CONFIG.fromEmail,
        To: to,
        Subject: subject,
        TextBody: body,
        ...(replyTo && { ReplyTo: replyTo }),
      }),
    });
    return;
  }

  // Fallback: MailChannels via Cloudflare Workers
  await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(emailPayload),
  });
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function extractSlugFromAddress(address) {
  // approve+my-post-slug@createrevenue.com → my-post-slug
  const match = address.match(/\+([^@]+)@/);
  return match ? match[1] : '';
}

function isApproval(body) {
  const normalized = body.trim().toLowerCase();
  return ['ok', 'okay', 'approve', 'publish', 'yes', 'go', 'lgtm', 'ship it'].some(
    word => normalized === word || normalized.startsWith(word + '\n') || normalized.startsWith(word + '\r')
  );
}

async function streamToText(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

function extractEmailBody(rawEmail) {
  // Simple extraction — get text after headers
  // In production, use a proper MIME parser
  const parts = rawEmail.split('\r\n\r\n');
  if (parts.length > 1) {
    return parts.slice(1).join('\r\n\r\n').trim();
  }
  return rawEmail.trim();
}
