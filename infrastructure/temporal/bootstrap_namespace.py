"""Wait for real Temporal readiness and create the application's default namespace."""
import asyncio
import os
import time

from google.protobuf.duration_pb2 import Duration
from temporalio.api.common.v1 import WorkflowExecution
from temporalio.api.errordetails.v1 import NamespaceNotFoundFailure
from temporalio.api.workflowservice.v1 import DescribeNamespaceRequest, DescribeWorkflowExecutionRequest, RegisterNamespaceRequest
from temporalio.client import Client
from temporalio.service import RPCError, RPCStatusCode


async def bootstrap():
    deadline = time.monotonic() + 90
    while True:
        try:
            client = await Client.connect(os.environ.get("TEMPORAL_HOST", "temporal:7233"))
            if not await client.service_client.check_health():
                raise RuntimeError("Temporal is not serving")
            try:
                await client.workflow_service.describe_namespace(DescribeNamespaceRequest(namespace="default"))
            except RPCError as error:
                if error.status != RPCStatusCode.NOT_FOUND:
                    raise
                try:
                    await client.workflow_service.register_namespace(RegisterNamespaceRequest(
                        namespace="default", workflow_execution_retention_period=Duration(seconds=86400)))
                except RPCError as registration:
                    if registration.status != RPCStatusCode.ALREADY_EXISTS:
                        raise
            # Registration is persisted before every service's namespace cache
            # observes it. Probe the history route using a deliberately absent
            # workflow; workflow-not-found is expected, namespace-not-found is not.
            try:
                await client.workflow_service.describe_workflow_execution(
                    DescribeWorkflowExecutionRequest(namespace="default", execution=WorkflowExecution(
                        workflow_id="inout-namespace-readiness-probe")))
            except RPCError as probe:
                if probe.status != RPCStatusCode.NOT_FOUND or any(
                    detail.Is(NamespaceNotFoundFailure.DESCRIPTOR) for detail in probe.grpc_status.details
                ):
                    raise
            print("Temporal gRPC health and default namespace verified")
            return client
        except (RPCError, RuntimeError):
            if time.monotonic() >= deadline:
                raise RuntimeError("Temporal did not become ready before the initialization deadline") from None
            await asyncio.sleep(1)


if __name__ == "__main__":
    asyncio.run(asyncio.wait_for(bootstrap(), timeout=95))
