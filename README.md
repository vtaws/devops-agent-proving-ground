# 🤖 DevOps Agent Proving Ground

Deploy broken AWS environments from real support cases, test DevOps Agent capabilities, and generate evidence decks for customer pitches.

## How It Works

1. **Fetch Cases** — Pulls real support cases from your CMC customer portfolio via `aws-support-mcp`
2. **AI Ranking** — Bedrock Claude ranks cases by reproducibility, resolution time, and DevOps Agent success likelihood
3. **Simulate** — Generates a simulation plan: broken state, root cause, symptoms, verification commands
4. **Deploy** — Creates a CloudFormation stack in your Isengard account that replicates the broken environment
5. **Test** — Run DevOps Agent against the deployed broken infra and measure its diagnostic accuracy

## Prerequisites

- AWS CLI v2 configured (Isengard account: 738884735220)
- `aws-support-mcp` toolbox: `toolbox install aws-support-mcp`
- Node.js 18+
- Midway authentication: `mwinit -o -s`

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:3000

When prompted, paste your Isengard credentials:
```bash
isengardcli credentials --account 738884735220 --role Admin
```

## Two Input Modes

### Auto-Fetch (recommended)
Select a customer from your CMC portfolio → cases are fetched and ranked by AI → click "Simulate" on the best candidate → click "Deploy" to create the broken environment.

### Manual Entry
Enter any ticket subject + service → AI generates the simulation plan → deploy directly.

## Architecture

```
┌────────────────────────────────────────────────┐
│  Next.js 14 (App Router)                       │
├──────────────┬─────────────────────────────────┤
│  Frontend    │  API Routes                     │
│  React UI   │  /api/devops-agent/customers     │ ← aws-support-mcp (CMC)
│             │  /api/devops-agent/cases          │ ← aws-support-mcp (Case API)
│             │  /api/devops-agent/rank-cases     │ ← Bedrock Claude Haiku
│             │  /api/devops-agent/simulate       │ ← Bedrock Claude Sonnet
│             │  /api/devops-agent/deploy         │ ← Bedrock + CloudFormation
│             │  /api/credentials/check|update    │ ← STS + .env.local
└──────────────┴─────────────────────────────────┘
```

## Tech Stack

- **Next.js 14** (App Router, TypeScript)
- **Tailwind CSS** (UI)
- **Amazon Bedrock** (Claude Sonnet for planning, Haiku for ranking)
- **AWS CloudFormation** (deployment)
- **aws-support-mcp** (customer/case data via toolbox)

## Key Decisions

- **No database** — stateless, runs locally
- **Direct CFN deployment** — no change management pipeline (this is a sandbox tool)
- **Isengard-only** — templates use minimal resources (t3.micro, small storage) to keep costs near zero
- **Auto-cleanup tags** — all stacks tagged with `AutoDelete=true` for easy identification and deletion


## 📦 Distribution — Share with Other TAMs

### One-Command Setup (for other TAMs)

1. Get the source (ask vtnair@ or clone from the internal repo):
   ```bash
   scp -r dev-dsk-vtnair-2a-d00ab4d4.us-west-2.amazon.com:~/devops-agent-proving-ground ~/devops-agent-proving-ground
   ```

2. Run the setup script:
   ```bash
   cd ~/devops-agent-proving-ground
   bash setup.sh
   ```

   The script handles everything:
   - Checks Node.js 18+ (installs via nvm if needed)
   - Installs `aws-support-mcp` via toolbox
   - Configures the correct MCP version path
   - Installs npm dependencies
   - Builds and starts the app

### What Each TAM Needs

| Requirement | How to get it |
|------------|---------------|
| Amazon laptop on VPN | Standard |
| `toolbox` | Pre-installed on corp machines |
| Midway auth | `mwinit -o` (standard TAM workflow) |
| Node.js 18+ | `nvm install 18` |
| Isengard account | Use your own Isengard for stack deployment |

### How Auth Works

- **Customer/case fetching**: Uses YOUR Midway session (your CMC access = your customers)
- **Stack deployment + DevOps Agent**: Uses Isengard creds you paste in the app
- Each TAM sees THEIR customers, runs tests in THEIR Isengard account

### Refreshing Midway

If case fetching fails with auth errors:
```bash
mwinit -o
```
Then refresh the app.
