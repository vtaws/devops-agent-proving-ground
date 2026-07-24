#!/bin/bash
#
# DevOps Agent Proving Ground — One-Click Setup
# Run: curl -s <URL>/setup.sh | bash
# Or:  bash setup.sh
#
# Prerequisites: Amazon laptop with corp VPN, toolbox, and mwinit
#

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color
BOLD='\033[1m'

echo ""
echo -e "${BOLD}🤖 DevOps Agent Proving Ground — Setup${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ─── Check prerequisites ─────────────────────────────────────────────────────

echo -e "${YELLOW}Checking prerequisites...${NC}"

# Check toolbox
if ! command -v toolbox &> /dev/null; then
    echo -e "${RED}✗ toolbox not found.${NC}"
    echo "  Install via: https://docs.hub.amazon.dev/builder-toolbox/user-guide/getting-started/"
    exit 1
fi
echo -e "${GREEN}✓${NC} toolbox"

# Check Node.js (need 18+)
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        echo -e "${YELLOW}⚠ Node.js $(node -v) found but need v18+. Installing via nvm...${NC}"
        if command -v nvm &> /dev/null; then
            nvm install 18
            nvm use 18
        else
            echo -e "${RED}✗ Node.js v18+ required but nvm not found.${NC}"
            echo "  Install nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
            echo "  Then: nvm install 18"
            exit 1
        fi
    fi
    echo -e "${GREEN}✓${NC} Node.js $(node -v)"
else
    echo -e "${YELLOW}⚠ Node.js not found. Installing via nvm...${NC}"
    if command -v nvm &> /dev/null; then
        nvm install 18
        nvm use 18
    else
        # Install nvm first
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        nvm install 18
        nvm use 18
    fi
    echo -e "${GREEN}✓${NC} Node.js $(node -v)"
fi

# Check npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗ npm not found.${NC}"
    exit 1
fi
echo -e "${GREEN}✓${NC} npm $(npm -v)"

# Check git
if ! command -v git &> /dev/null; then
    echo -e "${RED}✗ git not found.${NC}"
    exit 1
fi
echo -e "${GREEN}✓${NC} git"

# ─── Install aws-support-mcp ─────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}Installing aws-support-mcp tool...${NC}"

if [ -d "$HOME/.toolbox/tools/aws-support-mcp" ]; then
    echo -e "${GREEN}✓${NC} aws-support-mcp already installed"
else
    toolbox install aws-support-mcp
    echo -e "${GREEN}✓${NC} aws-support-mcp installed"
fi

# Find the latest version
MCP_VERSION=$(ls -t "$HOME/.toolbox/tools/aws-support-mcp/" | grep -E '^[0-9]' | head -1)
if [ -z "$MCP_VERSION" ]; then
    echo -e "${RED}✗ Could not find aws-support-mcp version${NC}"
    exit 1
fi
echo -e "${GREEN}✓${NC} aws-support-mcp version: $MCP_VERSION"

# ─── Check Midway auth ────────────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}Checking Midway authentication...${NC}"

if [ -f "$HOME/.midway/cookie" ]; then
    # Check if cookie is fresh (less than 12 hours old)
    COOKIE_AGE=$(( $(date +%s) - $(stat -f%m "$HOME/.midway/cookie" 2>/dev/null || stat -c%Y "$HOME/.midway/cookie" 2>/dev/null) ))
    if [ "$COOKIE_AGE" -gt 43200 ]; then
        echo -e "${YELLOW}⚠ Midway cookie is stale (>12h old). Refreshing...${NC}"
        echo -e "  Run: ${BOLD}mwinit -o${NC}"
        mwinit -o || {
            echo -e "${RED}✗ mwinit failed. Run manually: mwinit -o${NC}"
            echo "  Then re-run this script."
            exit 1
        }
    fi
    echo -e "${GREEN}✓${NC} Midway authenticated"
else
    echo -e "${YELLOW}⚠ No Midway cookie found. Authenticating...${NC}"
    mwinit -o || {
        echo -e "${RED}✗ mwinit failed. Run manually: mwinit -o${NC}"
        echo "  Then re-run this script."
        exit 1
    }
    echo -e "${GREEN}✓${NC} Midway authenticated"
fi

# ─── Clone/update the app ─────────────────────────────────────────────────────

APP_DIR="$HOME/devops-agent-proving-ground"
echo ""

if [ -d "$APP_DIR/src" ] && [ -f "$APP_DIR/package.json" ]; then
    echo -e "${GREEN}✓${NC} App source found at $APP_DIR"
    cd "$APP_DIR"
elif [ -f "./package.json" ] && [ -d "./src" ]; then
    # Running from within the project directory
    APP_DIR="$(pwd)"
    echo -e "${GREEN}✓${NC} Running from project directory: $APP_DIR"
else
    echo -e "${YELLOW}Setting up the app...${NC}"
    mkdir -p "$APP_DIR"
    # Try git clone if repo is configured
    if git clone https://github.com/vtaws/devops-agent-proving-ground.git "$APP_DIR" 2>/dev/null; then
        echo -e "${GREEN}✓${NC} Cloned from GitHub"
    else
        echo -e "${RED}✗ Could not find app source.${NC}"
        echo ""
        echo "  Option 1: Run this script from inside the project folder:"
        echo -e "    ${BOLD}cd /path/to/devops-agent-proving-ground && bash setup.sh${NC}"
        echo ""
        echo "  Option 2: Copy from the maintainer's CDD:"
        echo -e "    ${BOLD}scp -r <CDD_HOSTNAME>:~/devops-agent-proving-ground $APP_DIR${NC}"
        echo -e "    Then re-run: ${BOLD}bash $APP_DIR/setup.sh${NC}"
        exit 1
    fi
    cd "$APP_DIR"
fi

# ─── Create .env.local with correct MCP path ─────────────────────────────────

echo ""
echo -e "${YELLOW}Configuring environment...${NC}"

cat > .env.local << EOF
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6
BEDROCK_FAST_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0
DEVOPS_AGENT_RUNTIME_ID=
MCP_VERSION=$MCP_VERSION
EOF

echo -e "${GREEN}✓${NC} .env.local created"

# ─── Update mcp-call.py to use detected version ──────────────────────────────

if [ -f "scripts/mcp-call.py" ]; then
    sed -i.bak "s|aws-support-mcp/[0-9.]*|aws-support-mcp/$MCP_VERSION|g" scripts/mcp-call.py
    rm -f scripts/mcp-call.py.bak
    echo -e "${GREEN}✓${NC} MCP path updated to version $MCP_VERSION"
fi

# ─── Install npm dependencies ─────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}Installing dependencies...${NC}"
npm install --loglevel=error 2>&1 | tail -3
echo -e "${GREEN}✓${NC} npm packages installed"

# ─── Build ────────────────────────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}Building...${NC}"
npm run build 2>&1 | tail -3
echo -e "${GREEN}✓${NC} Build successful"

# ─── Done! ────────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}${BOLD}✅ Setup complete!${NC}"
echo ""
echo -e "To start the app:"
echo -e "  ${BOLD}cd $APP_DIR && npm start${NC}"
echo ""
echo -e "Then open: ${BOLD}http://localhost:3000${NC}"
echo ""
echo -e "${YELLOW}Notes:${NC}"
echo "  • Paste your Isengard credentials when prompted"
echo "  • Run 'mwinit -o' if case fetching fails (Midway expired)"
echo "  • Your customers will appear based on your CMC access"
echo ""
echo -e "For development mode (hot reload):"
echo -e "  ${BOLD}npm run dev${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Auto-start option
echo ""
read -p "Start the app now? [Y/n] " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
    echo -e "${GREEN}Starting...${NC}"
    npm start &
    sleep 3
    # Try to open browser
    if command -v open &> /dev/null; then
        open "http://localhost:3000"
    elif command -v xdg-open &> /dev/null; then
        xdg-open "http://localhost:3000"
    fi
    echo -e "${GREEN}App running at http://localhost:3000${NC}"
    echo "Press Ctrl+C to stop."
    wait
fi
