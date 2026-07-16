#!/bin/bash
# Run the DevOps Diagnostic Agent locally for testing
# Usage: ./run-local.sh

set -e

echo "Starting DevOps Diagnostic Agent locally..."
echo "Make sure you have valid AWS credentials (isengardcli credentials --account 738884735220 --role Admin)"

# Install dependencies if needed
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    uv venv .venv
    source .venv/bin/activate
    uv pip install -e .
else
    source .venv/bin/activate
fi

# Run the agent (A2A server on port 8001)
export AWS_REGION=us-east-1
python -c "
from strands import Agent
from tools.aws_inspect import (
    describe_stack, describe_ec2_instance, check_security_group_rules,
    check_iam_role_policies, check_vpc_connectivity, check_rds_status,
    check_cloudwatch_alarms, check_dns_resolution,
)
from model.load import load_model
import sys

agent = Agent(
    model=load_model(),
    tools=[describe_stack, describe_ec2_instance, check_security_group_rules,
           check_iam_role_policies, check_vpc_connectivity, check_rds_status,
           check_cloudwatch_alarms, check_dns_resolution],
    system_prompt=open('main.py').read().split(\"\"\"SYSTEM_PROMPT = \\\"\\\"\\\"\"\"\")[1].split(\"\"\"\\\"\\\"\\\"\"\"\" )[0] if False else '''You are an AWS DevOps Diagnostic Agent. Diagnose the broken environment by calling inspection tools. Start with describe_stack, then drill into specific resources. Report root cause and fix commands.'''
)

# Interactive mode
query = ' '.join(sys.argv[1:]) if len(sys.argv) > 1 else input('Describe the issue or provide stack name: ')
result = agent(query)
print('\\n=== AGENT RESPONSE ===')
print(result)
" "$@"
