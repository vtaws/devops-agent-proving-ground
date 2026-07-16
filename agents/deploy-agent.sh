#!/bin/bash
# Deploy DevOpsDiagnosticAgent to AgentCore
# Prerequisites:
#   - npm install -g @aws/agentcore@latest
#   - AWS credentials for account 738884735220
#   - Midway auth: mwinit -o -s

set -e

echo "🚀 Deploying DevOpsDiagnosticAgent to AgentCore..."
echo "   Account: 738884735220"
echo "   Region: us-east-1"
echo ""

cd "$(dirname "$0")/DevOpsDiagnosticAgent"

# Check agentcore CLI
if ! command -v agentcore &> /dev/null; then
    echo "❌ agentcore CLI not found. Install with: npm install -g @aws/agentcore@latest"
    exit 1
fi

# Deploy
agentcore deploy

echo ""
echo "✅ Deployed! Get the runtime ID with:"
echo "   agentcore list-runtimes"
echo ""
echo "To invoke locally:"
echo "   agentcore invoke --prompt 'Diagnose stack devops-sim-xxx in us-east-1. Symptoms: EC2 unreachable'"
echo ""
echo "Add the runtime ID to your .env.local:"
echo "   DEVOPS_AGENT_RUNTIME_ID=DevOpsDiagnosticAgent_DevOpsDiagnosticAgent-XXXXX"
