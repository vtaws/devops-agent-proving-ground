#!/usr/bin/env python3
"""
MCP Tool Caller — invoked by the Node.js app to call aws-support-mcp tools.
Usage: python3 scripts/mcp-call.py <tool_name> '<json_args>'
"""
import sys, os, json

# Setup paths
MCP_BASE = os.path.expanduser("~/.toolbox/tools/aws-support-mcp/1.0.1.78.0")
sys.path.insert(0, os.path.join(MCP_BASE, "lib/python3.10/site-packages"))
os.environ['REQUESTS_CA_BUNDLE'] = os.path.join(MCP_BASE, "lib/python3.10/site-packages/amazoncerts/internal_and_external_cacerts.pem")
os.environ['SSL_CERT_FILE'] = os.environ['REQUESTS_CA_BUNDLE']

import warnings
warnings.filterwarnings("ignore")

def get_customers(args):
    from aws_support_mcp.functions.cmc_client import CMCClient
    client = CMCClient()
    result = client.get_customers()
    if hasattr(result, 'data'):
        return {"success": True, "customers": result.data}
    return {"success": False, "error": str(result)}

def fetch_cases(args):
    from aws_support_mcp.functions.caseapi import fetch_cases as _fetch_cases
    result = _fetch_cases(
        case_ids=args.get("case_ids", None),
        customer_id=args.get("customer_id", ""),
        start_date=args.get("start_date", ""),
        case_status=args.get("case_status", ""),
        payer_id=args.get("payer_id", ""),
        include_communications=args.get("include_communications", True),
    )
    if isinstance(result, dict):
        return result
    return {"result": str(result)}

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: mcp-call.py <tool> '<json_args>'"}))
        sys.exit(1)
    
    tool = sys.argv[1]
    args = json.loads(sys.argv[2])
    
    try:
        if tool == "cmc_get_customers":
            result = get_customers(args)
        elif tool == "caseapi_fetch_cases":
            result = fetch_cases(args)
        else:
            result = {"error": f"Unknown tool: {tool}"}
        
        print(json.dumps(result, default=str))
    except Exception as e:
        print(json.dumps({"error": str(e), "type": type(e).__name__}))
