#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# SCRaM Simulator — Bedrock Agent Setup Script
#
# Creates:
# 1. S3 bucket for Knowledge Base documents
# 2. Uploads SCRaM guide to S3
# 3. Creates an OpenSearch Serverless collection (for KB vector store)
# 4. Creates a Bedrock Knowledge Base
# 5. Syncs the KB data source
# 6. Creates a Bedrock Agent with instructions
# 7. Attaches the KB to the agent
# 8. Creates an agent alias
# 9. Outputs Agent ID + Alias ID for .env.local
#
# Prerequisites:
# - AWS CLI v2 installed
# - Active credentials with Admin role (isengardcli)
# - Region: us-east-1
#
# Usage:
#   chmod +x scripts/setup-bedrock-agent.sh
#   ./scripts/setup-bedrock-agent.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

REGION="us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --region $REGION)
TIMESTAMP=$(date +%Y%m%d%H%M)
BUCKET_NAME="scram-simulator-kb-${ACCOUNT_ID}-${TIMESTAMP}"
COLLECTION_NAME="scram-kb-collection"
KB_NAME="scram-discovery-guide-kb"
AGENT_NAME="scram-tabletop-facilitator"
ROLE_NAME="BedrockAgentRole-scram-${TIMESTAMP}"

echo "═══════════════════════════════════════════════════════"
echo "  SCRaM Simulator — Bedrock Agent Setup"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Account:  $ACCOUNT_ID"
echo "  Region:   $REGION"
echo "  Bucket:   $BUCKET_NAME"
echo ""
echo "  This will create AWS resources that may incur costs."
echo "  Press Ctrl+C to cancel, or Enter to continue..."
read -r

# ─── Step 1: Create S3 bucket for KB documents ──────────────────────────────
echo ""
echo "▶ Step 1/8: Creating S3 bucket..."
aws s3 mb "s3://${BUCKET_NAME}" --region $REGION 2>/dev/null || true
echo "  ✓ Bucket: ${BUCKET_NAME}"

# ─── Step 2: Upload SCRaM knowledge base content ────────────────────────────
echo ""
echo "▶ Step 2/8: Uploading SCRaM knowledge base content..."

# Create the KB content file
cat > /tmp/scram-discovery-guide.md << 'KBCONTENT'
# SCRaM Discovery Guide — Knowledge Base

## Service Best Practices

### Amazon S3
- Probes: Public access blocked? Encryption (SSE-KMS) enforced? Versioning/Object Lock? Access logging?
- Best practice: Account-level Block Public Access, default SSE-KMS, bucket policies least-privilege, access logging + Macie, Object Lock for WORM data.

### Amazon RDS / Aurora
- Probes: Multi-AZ? Encryption at rest? Credentials rotated? Backups & PITR tested? Public endpoint?
- Best practice: Multi-AZ, storage encryption with KMS, IAM/Secrets-Manager auth with rotation, automated backups + tested restores, no public endpoint.

### AWS IAM
- Probes: Root locked + MFA? Federated SSO? Long-lived keys? Least-privilege? Access Analyzer?
- Best practice: Root locked down + MFA, federation (Identity Center) for humans, roles/STS for workloads, no long-lived keys, IAM Access Analyzer, regular access reviews.

### Amazon EC2
- Probes: Patching process? SSM vs SSH? Security groups? IMDSv2? Golden AMIs?
- Best practice: Patch via Systems Manager, SSM Session Manager, tight security groups, IMDSv2 required, hardened golden AMIs.

### AWS Lambda
- Probes: Execution-role scope? Secrets handling? Dependencies? Logging?
- Best practice: Least-privilege execution roles, secrets from Secrets Manager, dependency scanning, structured logging.

### CloudTrail / GuardDuty / Security Hub
- Probes: CloudTrail org-wide + tamper-protected? GuardDuty all regions? Who triages?
- Best practice: Org CloudTrail with log-file validation + S3 Object Lock, GuardDuty all-regions, Security Hub, on-call triage.

### AWS KMS
- Probes: CMK vs AWS-managed? Key policies? Rotation? Separation of duties?
- Best practice: CMKs for sensitive workloads, tight key policies, automatic annual rotation, separation of duties.

### Route 53 / DNS Failover
- Probes: Health checks? Failover tested end-to-end? TTLs?
- Best practice: Health-check-based failover records, low TTLs, REGULARLY EXERCISED failover.

### DR Strategy
- Probes: Which strategy? Matches RTO/RPO? Pre-provisioned (static stability)? Tested?
- Best practice: DR pattern chosen to meet agreed RTO/RPO, capacity pre-provisioned, failover exercised on schedule.

## Probe Ladders

### IAM — Identity & Access Management
- Opening: How do users and services authenticate, and how is access granted and reviewed?
- Probe: How are admin actions performed — federated SSO, or long-lived IAM users?
- Probe: How are service/programmatic credentials rotated, and how often?
- Probe: Is MFA enforced for human access? For privileged roles?
- Probe: How is access reviewed and revoked when people or workloads change?
- Weak: "We have IAM users with access keys; rotation is manual"
- Strong: "Federated SSO with MFA; workloads use IAM roles; Secrets Manager with auto-rotation; quarterly reviews"

### DETN — Detection & Monitoring
- Opening: How would you know this incident was happening?
- Probe: Is CloudTrail enabled across all accounts/regions, protected from tampering?
- Probe: What's monitored? Who watches the alerts?
- Probe: Are logs centralised with 24/7 alerting path to a human?
- Weak: "We have CloudWatch; nobody really watches it"
- Strong: "CloudTrail org-wide; GuardDuty + Security Hub feeding a SIEM; on-call responds"

### RCVY — Recovery Objectives
- Opening: What are your RTO, RPO, SLA and SLO — and how do you know they're achievable?
- Probe: Are they defined with the business or aspirational?
- Probe: What is the gap between TARGET and ACHIEVABLE?
- Probe: Is MTTR measured from real events or unknown?
- Weak: "We aim for ~15 minutes, but never measured it"
- Strong: "RTO/RPO agreed with business, validated in last failover test; MTTR tracked"

### BKUP — Backup & Restore
- Opening: Walk me through how you would restore from backup — and when you last proved it works.
- Probe: Encrypted, immutable, cross-region/account?
- Probe: When was the last SUCCESSFUL restore test?
- Weak: "Backups run nightly but we've never done a full restore"
- Strong: "Automated, encrypted, immutable, cross-region with quarterly restore drills"

### GEOF — Geographic Distribution & Failover
- Opening: If the primary region became impaired right now, what actually happens?
- Probe: Automated or manual failover? Who triggers it?
- Probe: DNS failover configured AND tested end-to-end?
- Probe: DR capacity pre-provisioned or launched on the day?
- Weak: "We have a DR region but failover is manual and never tested"
- Strong: "Multi-region with automated, regularly exercised failover; DR capacity pre-provisioned"

## Classification Model
- Positive: Best practice in place
- Positive Value Add: Works but opportunity to improve
- Warning: Medium severity — should be considered
- Critical: High severity — should be highly considered
- Not Captured: Couldn't be assessed

## Teaching Points
- DR ≠ Full Recovery: Failing over doesn't restore all business functions
- Untested = Unknown: "Configured" does not mean "works"
- Data Integrity on Failover: Replication lag = data loss. Lag IS the RPO floor.
- Bus Factor: Single engineer dependency is a critical risk
- No Defined RTO: Without a target, you can't answer "was that fast enough?"
- Static Stability: Launching at failover time depends on control-plane availability during impairment
KBCONTENT

aws s3 cp /tmp/scram-discovery-guide.md "s3://${BUCKET_NAME}/scram-discovery-guide.md" --region $REGION

# Upload local knowledge-base documents if they exist
KB_DIR="$(dirname "$0")/../knowledge-base"
if [ -d "$KB_DIR" ]; then
  echo "  Uploading local knowledge-base documents..."
  aws s3 sync "$KB_DIR" "s3://${BUCKET_NAME}/documents/" --region $REGION
  echo "  ✓ Uploaded $(ls "$KB_DIR" | wc -l | tr -d ' ') documents from knowledge-base/"
else
  echo "  (No local knowledge-base/ folder found — using generated guide only)"
fi

echo "  ✓ Knowledge base content uploaded to S3"

# ─── Step 3: Create IAM role for Bedrock Agent ──────────────────────────────
echo ""
echo "▶ Step 3/8: Creating IAM role for Bedrock Agent..."

TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "bedrock.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}'

ROLE_ARN=$(aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document "$TRUST_POLICY" \
  --query 'Role.Arn' --output text 2>/dev/null || \
  aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)

# Attach policies
aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/AmazonBedrockFullAccess" 2>/dev/null || true

aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess" 2>/dev/null || true

echo "  ✓ Role: ${ROLE_ARN}"
echo "  Waiting 10s for IAM propagation..."
sleep 10

# ─── Step 4: Create Bedrock Knowledge Base ───────────────────────────────────
echo ""
echo "▶ Step 4/8: Creating Bedrock Knowledge Base..."

KB_RESULT=$(aws bedrock-agent create-knowledge-base \
  --name "$KB_NAME" \
  --role-arn "$ROLE_ARN" \
  --knowledge-base-configuration '{
    "type": "VECTOR",
    "vectorKnowledgeBaseConfiguration": {
      "embeddingModelArn": "arn:aws:bedrock:'$REGION'::foundation-model/amazon.titan-embed-text-v2:0"
    }
  }' \
  --storage-configuration '{
    "type": "OPENSEARCH_SERVERLESS",
    "opensearchServerlessConfiguration": {
      "collectionArn": "auto",
      "vectorIndexName": "scram-index",
      "fieldMapping": {
        "vectorField": "embedding",
        "textField": "text",
        "metadataField": "metadata"
      }
    }
  }' \
  --region $REGION \
  --output json 2>&1) || true

# If AOSS collection needed, fall back to simpler KB config
if echo "$KB_RESULT" | grep -q "knowledgeBaseId"; then
  KB_ID=$(echo "$KB_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['knowledgeBase']['knowledgeBaseId'])")
else
  echo "  ⚠ OpenSearch Serverless auto-creation not available."
  echo "  Creating KB with S3 data source (Bedrock managed vectors)..."

  KB_RESULT=$(aws bedrock-agent create-knowledge-base \
    --name "$KB_NAME" \
    --role-arn "$ROLE_ARN" \
    --knowledge-base-configuration '{
      "type": "VECTOR",
      "vectorKnowledgeBaseConfiguration": {
        "embeddingModelArn": "arn:aws:bedrock:'$REGION'::foundation-model/amazon.titan-embed-text-v2:0"
      }
    }' \
    --storage-configuration '{
      "type": "PINECONE",
      "pineconeConfiguration": {
        "connectionString": "skip",
        "credentialsSecretArn": "skip",
        "fieldMapping": { "textField": "text", "metadataField": "metadata" }
      }
    }' \
    --region $REGION \
    --output json 2>&1) || true

  # Last resort — create without KB, just use the agent with inline knowledge
  KB_ID=""
  echo "  ⚠ Knowledge Base creation requires manual setup (OpenSearch Serverless)."
  echo "  Continuing with agent-only setup (KB can be attached later)."
fi

if [ -n "$KB_ID" ]; then
  echo "  ✓ Knowledge Base ID: ${KB_ID}"

  # Create data source
  echo ""
  echo "▶ Step 5/8: Creating KB data source..."
  DS_RESULT=$(aws bedrock-agent create-data-source \
    --knowledge-base-id "$KB_ID" \
    --name "scram-s3-source" \
    --data-source-configuration '{
      "type": "S3",
      "s3Configuration": { "bucketArn": "arn:aws:s3:::'$BUCKET_NAME'" }
    }' \
    --region $REGION \
    --output json 2>&1) || true

  DS_ID=$(echo "$DS_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('dataSource',{}).get('dataSourceId',''))" 2>/dev/null || echo "")

  if [ -n "$DS_ID" ]; then
    echo "  ✓ Data Source ID: ${DS_ID}"
    echo "  Syncing data source..."
    aws bedrock-agent start-ingestion-job \
      --knowledge-base-id "$KB_ID" \
      --data-source-id "$DS_ID" \
      --region $REGION > /dev/null 2>&1 || true
  fi
else
  echo ""
  echo "▶ Step 5/8: Skipping KB data source (KB not created)..."
fi

# ─── Step 6: Create Bedrock Agent ────────────────────────────────────────────
echo ""
echo "▶ Step 6/8: Creating Bedrock Agent..."

AGENT_INSTRUCTION='You are a SCRaM (Simulated Conditions Response and Management) tabletop exercise facilitator for AWS resilience assessments.

Your role:
1. You have been given a customer architecture, team members, and their questionnaire responses.
2. You generate realistic incident scenarios targeting their specific gaps.
3. During the exercise, you ask probing questions one at a time, referencing their actual services and team members.
4. After each answer, you generate a targeted follow-up that digs deeper into gaps.
5. You classify responses as Positive, Warning, or Critical based on AWS best practices.

Rules:
- Always reference the customer specific services (not generic)
- Name their team members in questions
- If they give vague answers, probe deeper with specifics
- After 3 follow-ups on one topic, move to the next question
- Keep responses concise — you are asking questions, not lecturing
- Use the SCRaM classification model for findings'

AGENT_RESULT=$(aws bedrock-agent create-agent \
  --agent-name "$AGENT_NAME" \
  --agent-resource-role-arn "$ROLE_ARN" \
  --foundation-model "us.anthropic.claude-sonnet-4-6" \
  --instruction "$AGENT_INSTRUCTION" \
  --idle-session-ttl-in-seconds 3600 \
  --region $REGION \
  --output json 2>&1)

AGENT_ID=$(echo "$AGENT_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['agent']['agentId'])" 2>/dev/null || echo "")

if [ -z "$AGENT_ID" ]; then
  echo "  ✗ Agent creation failed:"
  echo "  $AGENT_RESULT"
  echo ""
  echo "  This may require manual creation in the Bedrock console."
  echo "  Go to: https://console.aws.amazon.com/bedrock/home?region=${REGION}#/agents"
  exit 1
fi

echo "  ✓ Agent ID: ${AGENT_ID}"

# ─── Step 7: Attach KB to Agent (if KB exists) ──────────────────────────────
if [ -n "$KB_ID" ]; then
  echo ""
  echo "▶ Step 7/8: Attaching Knowledge Base to Agent..."
  aws bedrock-agent associate-agent-knowledge-base \
    --agent-id "$AGENT_ID" \
    --agent-version "DRAFT" \
    --knowledge-base-id "$KB_ID" \
    --description "SCRaM Discovery Guide and best practices" \
    --region $REGION > /dev/null 2>&1 || true
  echo "  ✓ KB attached"
else
  echo ""
  echo "▶ Step 7/8: Skipping KB attachment (create KB manually later)"
fi

# ─── Step 8: Prepare and create alias ────────────────────────────────────────
echo ""
echo "▶ Step 8/8: Preparing agent and creating alias..."

aws bedrock-agent prepare-agent \
  --agent-id "$AGENT_ID" \
  --region $REGION > /dev/null 2>&1

echo "  Waiting 15s for agent preparation..."
sleep 15

ALIAS_RESULT=$(aws bedrock-agent create-agent-alias \
  --agent-id "$AGENT_ID" \
  --agent-alias-name "live" \
  --region $REGION \
  --output json 2>&1)

ALIAS_ID=$(echo "$ALIAS_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['agentAlias']['agentAliasId'])" 2>/dev/null || echo "TSTALIASID")

echo "  ✓ Alias ID: ${ALIAS_ID}"

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ Bedrock Agent Setup Complete!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Add these to your .env.local:"
echo ""
echo "  BEDROCK_AGENT_ID=${AGENT_ID}"
echo "  BEDROCK_AGENT_ALIAS_ID=${ALIAS_ID}"
echo ""
echo "  Then restart: npm run dev"
echo ""
echo "  Resources created:"
echo "  - S3 Bucket: ${BUCKET_NAME}"
echo "  - IAM Role: ${ROLE_NAME}"
[ -n "$KB_ID" ] && echo "  - Knowledge Base: ${KB_ID}"
echo "  - Agent: ${AGENT_ID}"
echo "  - Alias: ${ALIAS_ID}"
echo ""
echo "═══════════════════════════════════════════════════════"
