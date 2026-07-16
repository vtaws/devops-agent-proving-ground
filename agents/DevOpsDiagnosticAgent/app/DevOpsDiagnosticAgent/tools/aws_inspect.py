"""AWS infrastructure inspection tools — real API calls to diagnose broken environments."""

from strands import tool
import boto3
import json


@tool
def describe_stack(stack_name: str, region: str = "us-east-1") -> dict:
    """Get full CloudFormation stack details including status, resources, outputs, and events.

    Args:
        stack_name: CloudFormation stack name or ID
        region: AWS region

    Returns:
        Stack status, resources, outputs, and recent events.
    """
    cfn = boto3.client("cloudformation", region_name=region)

    result = {"stack_name": stack_name, "region": region}

    # Stack status and outputs
    try:
        desc = cfn.describe_stacks(StackName=stack_name)
        stack = desc["Stacks"][0]
        result["status"] = stack["StackStatus"]
        result["outputs"] = [
            {"key": o["OutputKey"], "value": o["OutputValue"], "description": o.get("Description", "")}
            for o in stack.get("Outputs", [])
        ]
        result["parameters"] = [
            {"key": p["ParameterKey"], "value": p["ParameterValue"]}
            for p in stack.get("Parameters", [])
        ]
    except Exception as e:
        result["error"] = f"describe_stacks failed: {str(e)}"
        return result

    # Resources
    try:
        res = cfn.describe_stack_resources(StackName=stack_name)
        result["resources"] = [
            {"logical_id": r["LogicalResourceId"], "type": r["ResourceType"],
             "physical_id": r.get("PhysicalResourceId", ""), "status": r["ResourceStatus"]}
            for r in res["StackResources"]
        ]
    except Exception as e:
        result["resources_error"] = str(e)

    # Recent events (last 10)
    try:
        ev = cfn.describe_stack_events(StackName=stack_name)
        result["events"] = [
            {"resource": e["LogicalResourceId"], "status": e["ResourceStatus"],
             "reason": e.get("ResourceStatusReason", ""), "time": e["Timestamp"].isoformat()}
            for e in ev["StackEvents"][:10]
        ]
    except Exception as e:
        result["events_error"] = str(e)

    return result


@tool
def describe_ec2_instance(instance_id: str, region: str = "us-east-1") -> dict:
    """Get EC2 instance details including state, security groups, network, and status checks.

    Args:
        instance_id: EC2 instance ID (i-xxx)
        region: AWS region

    Returns:
        Instance state, networking, security groups, and status checks.
    """
    ec2 = boto3.client("ec2", region_name=region)
    result = {"instance_id": instance_id}

    try:
        desc = ec2.describe_instances(InstanceIds=[instance_id])
        inst = desc["Reservations"][0]["Instances"][0]
        result["state"] = inst["State"]["Name"]
        result["instance_type"] = inst["InstanceType"]
        result["vpc_id"] = inst.get("VpcId", "")
        result["subnet_id"] = inst.get("SubnetId", "")
        result["private_ip"] = inst.get("PrivateIpAddress", "")
        result["public_ip"] = inst.get("PublicIpAddress", "")
        result["security_groups"] = [{"id": sg["GroupId"], "name": sg["GroupName"]} for sg in inst.get("SecurityGroups", [])]
        result["iam_profile"] = inst.get("IamInstanceProfile", {}).get("Arn", "")
    except Exception as e:
        result["error"] = str(e)

    # Status checks
    try:
        status = ec2.describe_instance_status(InstanceIds=[instance_id])
        if status["InstanceStatuses"]:
            s = status["InstanceStatuses"][0]
            result["system_status"] = s["SystemStatus"]["Status"]
            result["instance_status"] = s["InstanceStatus"]["Status"]
        else:
            result["status_checks"] = "No status available (instance may be stopped)"
    except Exception as e:
        result["status_error"] = str(e)

    return result


@tool
def check_security_group_rules(security_group_id: str, region: str = "us-east-1") -> dict:
    """Get all inbound and outbound rules for a security group.

    Args:
        security_group_id: Security group ID (sg-xxx)
        region: AWS region

    Returns:
        Inbound and outbound rules with ports, protocols, and CIDR ranges.
    """
    ec2 = boto3.client("ec2", region_name=region)
    try:
        desc = ec2.describe_security_groups(GroupIds=[security_group_id])
        sg = desc["SecurityGroups"][0]
        return {
            "group_id": security_group_id,
            "group_name": sg["GroupName"],
            "vpc_id": sg["VpcId"],
            "inbound_rules": [
                {"protocol": r["IpProtocol"], "from_port": r.get("FromPort", "all"),
                 "to_port": r.get("ToPort", "all"),
                 "sources": [ip["CidrIp"] for ip in r.get("IpRanges", [])] +
                           [sg["GroupId"] for sg in r.get("UserIdGroupPairs", [])]}
                for r in sg["IpPermissions"]
            ],
            "outbound_rules": [
                {"protocol": r["IpProtocol"], "from_port": r.get("FromPort", "all"),
                 "to_port": r.get("ToPort", "all"),
                 "destinations": [ip["CidrIp"] for ip in r.get("IpRanges", [])] +
                                [sg["GroupId"] for sg in r.get("UserIdGroupPairs", [])]}
                for r in sg["IpPermissionsEgress"]
            ],
        }
    except Exception as e:
        return {"error": str(e)}


@tool
def check_iam_role_policies(role_name: str) -> dict:
    """Get IAM role policies (both inline and attached managed policies).

    Args:
        role_name: IAM role name

    Returns:
        Attached policies and inline policy documents.
    """
    iam = boto3.client("iam")
    result = {"role_name": role_name}

    try:
        # Attached managed policies
        attached = iam.list_attached_role_policies(RoleName=role_name)
        result["attached_policies"] = [
            {"name": p["PolicyName"], "arn": p["PolicyArn"]}
            for p in attached["AttachedPolicies"]
        ]
    except Exception as e:
        result["attached_error"] = str(e)

    try:
        # Inline policies
        inline = iam.list_role_policies(RoleName=role_name)
        result["inline_policies"] = inline["PolicyNames"]
    except Exception as e:
        result["inline_error"] = str(e)

    return result


@tool
def check_vpc_connectivity(vpc_id: str, region: str = "us-east-1") -> dict:
    """Check VPC configuration: subnets, route tables, internet gateway, NAT gateways.

    Args:
        vpc_id: VPC ID
        region: AWS region

    Returns:
        VPC subnets, route tables, gateways, and connectivity status.
    """
    ec2 = boto3.client("ec2", region_name=region)
    result = {"vpc_id": vpc_id}

    try:
        subnets = ec2.describe_subnets(Filters=[{"Name": "vpc-id", "Values": [vpc_id]}])
        result["subnets"] = [
            {"id": s["SubnetId"], "cidr": s["CidrBlock"], "az": s["AvailabilityZone"],
             "public": s.get("MapPublicIpOnLaunch", False)}
            for s in subnets["Subnets"]
        ]
    except Exception as e:
        result["subnets_error"] = str(e)

    try:
        igws = ec2.describe_internet_gateways(Filters=[{"Name": "attachment.vpc-id", "Values": [vpc_id]}])
        result["internet_gateways"] = [igw["InternetGatewayId"] for igw in igws["InternetGateways"]]
    except Exception as e:
        result["igw_error"] = str(e)

    try:
        nats = ec2.describe_nat_gateways(Filter=[{"Name": "vpc-id", "Values": [vpc_id]}])
        result["nat_gateways"] = [
            {"id": n["NatGatewayId"], "state": n["State"], "subnet": n.get("SubnetId", "")}
            for n in nats["NatGateways"]
        ]
    except Exception as e:
        result["nat_error"] = str(e)

    try:
        rts = ec2.describe_route_tables(Filters=[{"Name": "vpc-id", "Values": [vpc_id]}])
        result["route_tables"] = [
            {"id": rt["RouteTableId"],
             "routes": [{"dest": r.get("DestinationCidrBlock", ""), "target": r.get("GatewayId", r.get("NatGatewayId", r.get("InstanceId", "local")))} for r in rt["Routes"]]}
            for rt in rts["RouteTables"]
        ]
    except Exception as e:
        result["routes_error"] = str(e)

    return result


@tool
def check_rds_status(db_identifier: str, region: str = "us-east-1") -> dict:
    """Check RDS instance status, connectivity settings, and recent events.

    Args:
        db_identifier: RDS instance or cluster identifier
        region: AWS region

    Returns:
        DB status, endpoint, security groups, and connectivity info.
    """
    rds = boto3.client("rds", region_name=region)
    result = {"db_identifier": db_identifier}

    try:
        desc = rds.describe_db_instances(DBInstanceIdentifier=db_identifier)
        db = desc["DBInstances"][0]
        result["status"] = db["DBInstanceStatus"]
        result["engine"] = f"{db['Engine']} {db['EngineVersion']}"
        result["endpoint"] = db.get("Endpoint", {}).get("Address", "")
        result["port"] = db.get("Endpoint", {}).get("Port", "")
        result["publicly_accessible"] = db.get("PubliclyAccessible", False)
        result["vpc_security_groups"] = [
            {"id": sg["VpcSecurityGroupId"], "status": sg["Status"]}
            for sg in db.get("VpcSecurityGroups", [])
        ]
        result["multi_az"] = db.get("MultiAZ", False)
        result["storage_encrypted"] = db.get("StorageEncrypted", False)
    except Exception as e:
        result["error"] = str(e)

    return result


@tool
def check_cloudwatch_alarms(stack_name: str, region: str = "us-east-1") -> dict:
    """Check CloudWatch alarms related to stack resources.

    Args:
        stack_name: Stack name to filter alarms by
        region: AWS region

    Returns:
        Active alarms and their states.
    """
    cw = boto3.client("cloudwatch", region_name=region)
    try:
        alarms = cw.describe_alarms(MaxRecords=20)
        relevant = [
            {"name": a["AlarmName"], "state": a["StateValue"],
             "metric": a.get("MetricName", ""), "reason": a.get("StateReason", "")}
            for a in alarms["MetricAlarms"]
            if stack_name.lower() in a.get("AlarmName", "").lower() or
               a["StateValue"] == "ALARM"
        ]
        return {"alarms": relevant, "total_in_alarm": sum(1 for a in alarms["MetricAlarms"] if a["StateValue"] == "ALARM")}
    except Exception as e:
        return {"error": str(e)}


@tool
def check_dns_resolution(hosted_zone_id: str = "", domain_name: str = "", region: str = "us-east-1") -> dict:
    """Check Route 53 DNS records for a hosted zone or domain.

    Args:
        hosted_zone_id: Route 53 hosted zone ID (optional)
        domain_name: Domain name to look up records for (optional)
        region: AWS region

    Returns:
        DNS records found.
    """
    r53 = boto3.client("route53")
    result = {}

    try:
        if hosted_zone_id:
            records = r53.list_resource_record_sets(HostedZoneId=hosted_zone_id, MaxItems="20")
            result["records"] = [
                {"name": r["Name"], "type": r["Type"],
                 "values": [v.get("Value", "") for v in r.get("ResourceRecords", [])] or [r.get("AliasTarget", {}).get("DNSName", "")]}
                for r in records["ResourceRecordSets"]
            ]
        elif domain_name:
            zones = r53.list_hosted_zones_by_name(DNSName=domain_name, MaxItems="5")
            result["matching_zones"] = [
                {"id": z["Id"], "name": z["Name"], "private": z["Config"].get("PrivateZone", False)}
                for z in zones["HostedZones"]
            ]
    except Exception as e:
        result["error"] = str(e)

    return result
