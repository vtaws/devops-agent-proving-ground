#!/bin/bash
# Deploy DevOps Agent Proving Ground to an EC2 instance in Isengard
# Usage: ./deploy-ec2.sh
#
# Prerequisites:
# - AWS credentials configured for account <YOUR_ACCOUNT_ID>
# - A default VPC in us-east-1 with a public subnet

set -e

REGION="us-east-1"
INSTANCE_TYPE="t3.small"
AMI_ID="ami-0c02fb55956c7d316"  # Amazon Linux 2023 us-east-1
KEY_NAME="devops-proving-ground"
SG_NAME="devops-proving-ground-sg"
STACK_NAME="devops-proving-ground-host"

echo "🚀 Deploying DevOps Agent Proving Ground to EC2..."
echo "   Region: $REGION"
echo "   Instance: $INSTANCE_TYPE"

# Create security group (allow 3000 from Amazon corp ranges)
echo "Creating security group..."
SG_ID=$(aws ec2 create-security-group \
  --group-name "$SG_NAME" \
  --description "DevOps Proving Ground web access" \
  --region "$REGION" \
  --query 'GroupId' --output text 2>/dev/null || \
  aws ec2 describe-security-groups \
    --group-names "$SG_NAME" \
    --region "$REGION" \
    --query 'SecurityGroups[0].GroupId' --output text)

# Allow port 3000 from 10.0.0.0/8 (Amazon corp) and SSH
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 3000 --cidr 10.0.0.0/8 --region "$REGION" 2>/dev/null || true
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 22 --cidr 10.0.0.0/8 --region "$REGION" 2>/dev/null || true

echo "   Security Group: $SG_ID"

# User data script to install Node.js and run the app
USER_DATA=$(cat <<'EOF'
#!/bin/bash
yum update -y
yum install -y git
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
yum install -y nodejs

# Clone and build
mkdir -p /opt/app
cd /opt/app
cat > /opt/app/setup.sh << 'SETUP'
#!/bin/bash
cd /opt/app
npm install
npm run build
# Run in production mode
PORT=3000 node .next/standalone/server.js &
SETUP
chmod +x /opt/app/setup.sh

# Create systemd service
cat > /etc/systemd/system/devops-app.service << 'SVC'
[Unit]
Description=DevOps Agent Proving Ground
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/opt/app
ExecStart=/usr/bin/node /opt/app/.next/standalone/server.js
Restart=always
Environment=PORT=3000
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVC

echo "Instance ready. Upload app code via scp then run: sudo systemctl start devops-app"
EOF
)

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "EC2 instance would be created with:"
echo "  AMI: Amazon Linux 2023 ($AMI_ID)"
echo "  Type: $INSTANCE_TYPE"
echo "  SG: Port 3000 open to 10.0.0.0/8"
echo ""
echo "After launch, deploy the app with:"
echo "  1. scp -r . ec2-user@<IP>:/opt/app/"
echo "  2. ssh ec2-user@<IP> 'cd /opt/app && npm install && npm run build'"
echo "  3. ssh ec2-user@<IP> 'cd /opt/app && PORT=3000 node .next/standalone/server.js'"
echo ""
echo "Testers access: http://<EC2-PRIVATE-IP>:3000"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
