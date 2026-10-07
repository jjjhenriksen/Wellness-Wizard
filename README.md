# Wellness Wizard

## About the Project
Wellness Wizard is our team's submission to the inaugural PantherHacks! Our AI-powered chatbot is designed to provide you with personalized wellness tips, resources, and support. Whether you're feeling stressed, anxious, or just need someone to talk to, Wellness Wizard is your go-to companion for all things wellness. Wellness Wizard uses OpenAI's gpt-4.1-nano model.

We used [Chapman University brand colors](https://brand.chapman.edu/colors/) in honor of PantherHacks being the first Chapman hackathon! 

We built this web application using Bootstrap, Node.js, and the OpenAI API.

## Getting Started
### Libraries/Dependencies Used
**Icons:**
- https://icons.getbootstrap.com/
- https://fontawesome.com/icons

**APIs:**
- OpenAI API
- Bootstrap (https://getbootstrap.com/)
- Node.js

### To execute the project locally:
Install Node.js 22 (the supported runtime), then install the locked dependencies:

```sh
npm ci
npm test
npm run dev
```

`npm run dev` uses the repository's Vercel CLI. Navigate to
`http://localhost:3000`. Add `OPENAI_API_KEY` to your untracked `.env` to use
chat. Tests mock every provider request and require no key or paid calls.
The API uses ES modules, declared explicitly in `package.json`.

### Request policy

Messages must be non-empty strings of at most 4,000 characters. Provider
requests time out after 15 seconds and return `504 / PROVIDER_TIMEOUT`.
The browser uses latest-send-wins: obsolete responses and typing timers cannot
overwrite the newest answer. Browser cancellation does not refund server quota
or guarantee cancellation of an upstream call.

Before calling the paid provider, the server reserves both a per-caller quota
(10 requests per 60-second window) and a deployment-wide quota (100 requests
per 60-second window). Windows begin with the first accepted request. `429`
responses include `Retry-After` and `retryAfterSeconds`.

Production and Vercel preview deployments require an existing Redis REST
backend configured through `UPSTASH_REDIS_REST_URL` (HTTPS) and
`UPSTASH_REDIS_REST_TOKEN`. An atomic Redis script shares both quotas across
instances. Use a separate backend per environment to avoid sharing budgets.
Missing, malformed, timed-out, or failed quota backends return
`503 / QUOTA_UNAVAILABLE` without contacting OpenAI. This repository does not
provision a backend. Local development without these variables uses bounded,
process-local counters, not a deployment-wide cost guarantee.

On Vercel, identity uses its platform-overwritten `x-vercel-forwarded-for`
header; elsewhere, the socket address is used. Unknown callers share a bucket.
Generic client-supplied forwarding headers are ignored. Quota keys contain
hashed addresses, never message content.


Congratulations, you've summoned the Wellness Wizard! ✨
