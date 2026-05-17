# Chapter 14: The Multi-Microservice Coordination Pattern
*Part III: Delivery & Deployment Patterns (CD)*

> *"We deployed the API service first. It dropped support for v1 responses.
> The consumer service still expected v1 responses.
> Twenty minutes of 500 errors while we raced to deploy the consumer.
> 'Deploy API first, then consumers' was the unwritten rule.
> Nobody wrote it down because everybody knew it.
> Until the new engineer didn't."*
> — Slack message sent at 2:14 AM, preserved for posterity

---

## The War Story

Veridian Commerce has 34 microservices. The checkout flow involves 7 of them: `cart-service`, `inventory-service`, `pricing-service`, `payment-service`, `order-service`, `notification-service`, and `fulfillment-service`. When a customer clicks "Buy," these 7 services make 23 API calls between them.

In October, the platform team decides to overhaul the pricing API. The `pricing-service`'s response format changes: the `price` field moves from a top-level field to a nested `amounts.total` field. It's a cleaner API. Three services depend on it: `cart-service`, `order-service`, and `checkout-frontend`.

The migration plan (informal, in Slack, not written down anywhere durable):
1. Deploy `pricing-service` with both old and new response format (compatibility shim)
2. Deploy `cart-service`, `order-service`, `checkout-frontend` — all updated to use `amounts.total`
3. Deploy `pricing-service` without the compatibility shim

The plan looks sensible. The execution fails at step 1. The engineer who deploys `pricing-service` deploys the version WITHOUT the compatibility shim — the PR that added the shim was never merged because someone left a "could we simplify this?" comment and the author assumed the PR was blocked.

`pricing-service` is live. The new response format is live. `cart-service`, `order-service`, and `checkout-frontend` still use the old format. All three start throwing `TypeError: Cannot read properties of undefined (reading 'total')` in their pricing calls.

The checkout flow breaks for 100% of users. The incident lasts 34 minutes before the rollback completes. Revenue impact: ~$840,000 in missed orders, calculated at the post-incident retrospective.

The root cause: no contract enforcement between services. The informal migration plan had no mechanism to prevent step 1 from deploying the wrong version. The API change was not tested against consumers before deployment. The deployment order was not enforced by the pipeline.

---

## What You'll Learn

- Consumer-driven contract testing with Pact: how to encode API contracts as tested artifacts and fail the pipeline before breaking changes reach production
- The deployment order problem: how to express and enforce service deployment dependencies in the pipeline
- The version compatibility matrix: tracking which versions of services are compatible with each other
- Service mesh traffic splitting for coordinated multi-service rollouts
- The strangler fig for API versioning: how to add new contract versions without breaking old consumers

---

## Consumer-Driven Contract Testing

Contract testing is the solution to the inter-service testing gap that the test pyramid ignores (Chapter 2 introduced this concept; here we implement it fully).

In consumer-driven contract testing (Pact is the dominant framework):

1. **The consumer** (e.g., `cart-service`) writes a test that records what it expects from the provider (`pricing-service`): the request format, the response format, the response fields it uses.
2. Pact generates a **contract file** from those expectations.
3. The contract is published to a **Pact Broker** (a shared contract repository).
4. **The provider** (`pricing-service`) runs a verification test that confirms it satisfies all registered consumer contracts.
5. Before any deployment, the `can-i-deploy` check queries the Pact Broker: "is the version I'm about to deploy compatible with all of its consumers at the target environment?"

```python
# cart-service/tests/test_pricing_contract.py
# Consumer-side contract test — defines what cart-service expects from pricing-service

import pytest
from pact import Consumer, Provider

# Define the Pact between consumer (cart-service) and provider (pricing-service)
pact = Consumer('cart-service').has_pact_with(
    Provider('pricing-service'),
    host_name='localhost',
    port=1234,
    pact_dir='./pacts'
)

def test_get_product_price():
    """cart-service expects pricing-service to return a price for a given product."""
    
    # Define what cart-service will send
    expected_request = {
        'method': 'GET',
        'path': '/price/product-sku-123',
        'headers': {'Accept': 'application/json'}
    }
    
    # Define what cart-service needs back — ONLY the fields it actually uses.
    # Don't over-specify: if cart-service only uses `amounts.total`,
    # don't assert on `amounts.subtotal`, `amounts.tax`, etc.
    # Over-specifying creates brittle contracts that break when the provider
    # adds new fields (which should be a backward-compatible change).
    expected_response = {
        'status': 200,
        'headers': {'Content-Type': 'application/json'},
        'body': {
            'amounts': {
                # cart-service uses amounts.total to display the item price.
                # This field MUST exist with a numeric value.
                'total': 29.99
            }
        }
    }
    
    # This test runs cart-service's pricing call against a Pact mock server.
    # The mock server validates that cart-service's request matches the
    # expected_request spec, then returns the expected_response.
    # On success, Pact generates a contract file in ./pacts/.
    (pact
     .given('product sku-123 exists with a price')
     .upon_receiving('a request for product price')
     .with_request(**expected_request)
     .will_respond_with(**expected_response))

    with pact:
        # This is the actual cart-service code that calls pricing-service.
        # It runs against the Pact mock, not the real pricing-service.
        from cart_service.pricing_client import PricingClient
        client = PricingClient(base_url='http://localhost:1234')
        result = client.get_price('product-sku-123')
        
        assert result['amounts']['total'] == 29.99
    
    # After the test runs, Pact has generated pacts/cart-service-pricing-service.json
    # containing the contract. This file is published to the Pact Broker.
```

```python
# pricing-service/tests/test_pact_provider.py
# Provider-side verification — confirms pricing-service satisfies all consumer contracts

import pytest
from pact import Verifier

def test_pricing_service_satisfies_contracts():
    """Verify that pricing-service satisfies all consumer contracts in the Pact Broker."""
    
    verifier = Verifier(
        provider='pricing-service',
        provider_base_url='http://localhost:8080'  # pricing-service running locally
    )
    
    # Fetch all contracts for pricing-service from the Pact Broker.
    # This automatically tests against EVERY consumer's contract, not just cart-service.
    # When a new consumer registers a contract, it's automatically tested here.
    output, _ = verifier.verify_with_broker(
        broker_url='https://pact-broker.myorg.com',
        broker_token=os.environ['PACT_BROKER_TOKEN'],
        # Only test consumers deployed to the target environment.
        # Don't fail on a contract from a consumer that's only in dev.
        consumer_version_selectors=[
            {"deployedOrReleased": True, "environment": "staging"},
            {"mainBranch": True}
        ],
        # State handlers: set up the database state for each test.
        # "product sku-123 exists with a price" → seed the test database
        provider_states_setup_url='http://localhost:8080/_pact/provider_states'
    )
    
    assert output == 0, "Provider verification failed — would break consumers"
```

### The `can-i-deploy` Check in CI

```yaml
# In the pricing-service deployment pipeline
- name: Check can-i-deploy to staging
  run: |
    # This command queries the Pact Broker:
    # "Is pricing-service version ${{ github.sha }} compatible with
    # all other services currently deployed to staging?"
    #
    # It checks BOTH directions:
    # - Does pricing-service satisfy its consumers' contracts?
    # - Do pricing-service's consumed contracts (what it calls) still work?
    #
    # If this check fails, the deployment is blocked.
    # The Veridian incident can't happen: deploying the wrong pricing-service
    # version would have failed here with a clear error message showing
    # exactly which consumer contract is violated.
    pact-broker can-i-deploy \
      --pacticipant pricing-service \
      --version ${{ github.sha }} \
      --to-environment staging \
      --broker-base-url https://pact-broker.myorg.com \
      --broker-token ${{ secrets.PACT_BROKER_TOKEN }}
```

The output when this check fails:
```
Computer says no ¯\_(ツ)_/¯

REASON: There is no verified pact between a version of pricing-service 
that is compatible with the versions of the following pacticipants 
that are deployed to staging:

  cart-service (2.1.4): The pact between cart-service (2.1.4) and 
    pricing-service has failed verification by pricing-service (sha-a3f8c2d).
    
    Failures:
      - 'amounts.total' field missing from response body
        Expected: { amounts: { total: 29.99 } }
        Actual:   { price: 29.99 }
```

Clear, actionable, specific. The pipeline knows about the contract violation before the deployment runs.

---

## The Deployment Order Problem

Contract testing prevents deploying incompatible versions. Deployment order addresses a different problem: even with compatible versions, the order in which services are deployed determines whether there's a window of incompatibility during the rollout.

The rule: **deploy providers before consumers when adding new fields; deploy consumers before providers when removing fields**.

```mermaid
flowchart TD
  subgraph Add["Adding a field (backward-compatible)"]
    A1["pricing-service adds amounts.total<br/>(keeps price for now)"]
    A2["Deploy pricing-service FIRST"]
    A3["Deploy cart-service<br/>(uses amounts.total)"]
    A4["Remove price field from pricing-service LATER"]
    A1 --> A2 --> A3 --> A4
  end

  subgraph Remove["Removing a field (backward-incompatible)"]
    R1["pricing-service will remove price field"]
    R2["Deploy cart-service FIRST<br/>(uses amounts.total)"]
    R3["Deploy pricing-service<br/>(without price field)"]
    R4["No incompatibility window:<br/>consumer never needs dropped field"]
    R1 --> R2 --> R3 --> R4
  end

  style Add fill:#0f3460,color:#ffffff
  style Remove fill:#533483,color:#ffffff
```

The Veridian incident: the wrong version of pricing-service was deployed because no mechanism encoded the "deploy the shim first" requirement. The correct implementation:

```yaml
# deployment-pipeline.yml — multi-service coordinated deploy
# This pipeline enforces the deployment order and contract compatibility.

jobs:
  # Step 1: Deploy pricing-service WITH the compatibility shim.
  # This version supports both old (price) and new (amounts.total) response formats.
  deploy-pricing-shim:
    uses: ./.github/workflows/deploy-service.yml
    with:
      service: pricing-service
      version: ${{ needs.build.outputs.pricing-sha }}
      # Verify this specific version tag identifies the shim version, not the post-shim version.
      # This is where an explicit promotion tag matters — not just a SHA.
      environment: production
    secrets: inherit

  # Step 2: Deploy consumers — these are now safe because the provider supports both formats.
  deploy-consumers:
    needs: [deploy-pricing-shim]  # MUST wait for step 1
    strategy:
      matrix:
        service: [cart-service, order-service, checkout-frontend]
    uses: ./.github/workflows/deploy-service.yml
    with:
      service: ${{ matrix.service }}
      version: ${{ needs.build.outputs[format('{0}-sha', matrix.service)] }}
      environment: production

  # Step 3: Only after ALL consumers are deployed, remove the shim.
  deploy-pricing-final:
    needs: [deploy-consumers]  # MUST wait for step 2 to fully complete
    uses: ./.github/workflows/deploy-service.yml
    with:
      service: pricing-service
      version: ${{ needs.build.outputs.pricing-final-sha }}
      environment: production
```

---

## Service Mesh Traffic Splitting for Coordinated Rollouts

When deploying multiple interdependent services, a service mesh allows progressive traffic shifting that respects the inter-service dependency graph.

```yaml
# istio-virtualservice-coordinated.yaml
# During a coordinated rollout: pricing-service and cart-service are being updated simultaneously.
# Traffic splitting routes consistent traffic to matched versions.
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: pricing-service
spec:
  hosts:
    - pricing-service
  http:
    # Route 10% of traffic to the new pricing-service version.
    # Only allow this traffic to be served by new cart-service too.
    # This prevents mixing old cart-service with new pricing-service responses.
    - match:
        - headers:
            x-version-group:
              exact: "v2"
      route:
        - destination:
            host: pricing-service
            subset: v2
          weight: 100

    # Default: old pricing-service version for all other traffic.
    - route:
        - destination:
            host: pricing-service
            subset: v1
          weight: 100
---
apiVersion: networking.istio.io/v1alpha3
kind: DestinationRule
metadata:
  name: pricing-service
spec:
  host: pricing-service
  subsets:
    - name: v1
      labels:
        version: "v1"
    - name: v2
      labels:
        version: "v2"
```

The consistent header routing (`x-version-group: v2`) ensures that a request going to `cart-service-v2` also reaches `pricing-service-v2`, preventing the mixed-version compatibility window.

---

## The Version Compatibility Matrix

For systems with many interdependent services, maintaining a version compatibility matrix makes the deployment order explicit and queryable:

```yaml
# compatibility-matrix.yaml — stored in the config repo
# Each entry declares which version ranges of a provider are compatible
# with which version ranges of a consumer.
# Updated by the release pipeline when new contract verifications pass.

services:
  pricing-service:
    v2.1.x:
      compatible_consumers:
        cart-service: ">=2.0.0"       # cart-service 2.0+ uses amounts.total
        order-service: ">=1.8.0"
        checkout-frontend: ">=3.2.0"
      incompatible_consumers:
        cart-service: "<2.0.0"        # Old cart-service uses the removed price field

    v2.0.x:
      compatible_consumers:
        cart-service: ">=1.5.0, <2.0.0"  # shim period — supports old and new
        order-service: ">=1.6.0"
```

```python
# ci/check_deployment_order.py — run before any multi-service deployment
import yaml, sys, semver

def check_compatibility(provider: str, provider_version: str, 
                        consumer: str, consumer_version: str) -> bool:
    with open('compatibility-matrix.yaml') as f:
        matrix = yaml.safe_load(f)
    
    provider_compat = matrix['services'].get(provider, {})
    for version_range, compat in provider_compat.items():
        if semver.match(provider_version, version_range):
            consumers = compat.get('compatible_consumers', {})
            constraint = consumers.get(consumer)
            if constraint and semver.match(consumer_version, constraint):
                return True
            incompat = compat.get('incompatible_consumers', {})
            if consumer in incompat:
                return False
    return True  # Unknown = assume compatible, let contract tests catch it

if not check_compatibility('pricing-service', '2.1.0', 'cart-service', '1.9.0'):
    print("DEPLOYMENT BLOCKED: pricing-service 2.1.0 is incompatible with cart-service 1.9.0")
    sys.exit(1)
```

---

## When Multi-Service Coordination Breaks

### Break Mode 1: Contract Test Versions Out of Sync

The Pact Broker has contracts from old consumer versions. A new consumer version changes its API expectations (a legitimate change) but hasn't published new contracts yet. The `can-i-deploy` check fails because it's comparing the provider against stale consumer contracts.

Fix: contracts are published on every consumer CI run, not just on merge. The Pact Broker keeps version history; `can-i-deploy` queries against the correct consumer version for the target environment.

### Break Mode 2: Deployment Order Not Enforced, Only Documented

"The order is in the deployment runbook" is not enforcement. It is a request. Humans under pressure skip runbooks.

Fix: deployment order must be encoded in `needs:` dependencies in the pipeline, not in documentation. If the pipeline job for step 2 has `needs: [step-1]`, it physically cannot run before step 1 completes.

### Break Mode 3: Circular Service Dependencies

Service A depends on service B; service B depends on service A. In a circular dependency, there is no "safe" deployment order. Each deploy creates a window of incompatibility.

Fix: circular dependencies are an architecture problem, not a deployment problem. Identify the cycle and break it with an intermediate abstraction or event-driven decoupling. If the architecture can't be changed immediately, deploy a compatibility shim in both services simultaneously and accept the brief incompatibility window.

---

## The Anti-Patterns

### ❌ Anti-Pattern: Provider Deploys Without Consumer Contract Verification

**What it looks like:** `pricing-service` adds a breaking change, publishes to the registry, CI passes (it tested pricing-service in isolation), and the deployment proceeds without checking whether consumers are compatible.

**Why it happens:** Contract tests weren't added when the service was first built. Adding them later requires organizational coordination between teams.

**What breaks:** Consumers that rely on the changed API. The Veridian incident, precisely.

**The fix:** `can-i-deploy` as a required pipeline gate for every deployment. Takes 30 seconds to execute. Prevents the class of incident that takes 34 minutes to resolve and costs $840,000 in missed orders.

---

### ❌ Anti-Pattern: Testing Services Only in Isolation

**What it looks like:** Each service has unit tests and integration tests with mocked dependencies. The mock for `pricing-service` in `cart-service`'s tests returns `{"price": 29.99}`. `pricing-service` changes its response to `{"amounts": {"total": 29.99}}`. Both services' tests pass. The integration breaks.

**Why it happens:** Mock-based testing doesn't validate that the mock accurately models the real service's behavior.

**What breaks:** Any integration point between services. The mocks become a lie maintained in parallel with the real API, diverging over time.

**The fix:** Replace mocks with Pact contracts. The consumer's "mock" is a Pact mock server that is verified against the real provider. When the provider's API changes, the Pact verification fails — before the change ships.

---

### ❌ Anti-Pattern: Unversioned APIs

**What it looks like:** The `pricing-service` API has no versioning. Clients call `/price/sku-123`. When the response format changes, all clients break simultaneously.

**Why it happens:** API versioning was "planned for later" and never implemented.

**What breaks:** The ability to make any backward-incompatible API changes without coordinated multi-service deployment.

**The fix:** Version APIs from day one (`/v1/price/sku-123`). Maintain the old version until all consumers have migrated. Use the Pact Broker's contract-per-environment feature to track which environments still use v1 consumers.

---

## Field Notes

💀 **"Deploy API first, then consumers" exists only in someone's head** → New engineer doesn't know, breaks the deployment order, 20 minutes of 500 errors → Encode deployment order in `needs:` pipeline dependencies. If it's in the pipeline, it can't be skipped.

💀 **Contract tests exist but aren't run as pipeline gates** → Contracts drift, `can-i-deploy` isn't checked, the contract test suite becomes vestigial → `can-i-deploy` runs before every deployment to a shared environment. This is the gate. Without it, contracts are documentation.

💀 **Provider-side contract verification skipped because "it's slow"** → Provider deploys incompatible changes → Provider verification takes 2–3 minutes. The cost of skipping: 34-minute incident. Run it.

---

## Chapter Summary

Multi-microservice coordination is fundamentally a contract management problem. The Veridian incident happened because no mechanism existed to verify that the version of `pricing-service` being deployed was compatible with the versions of its consumers already running in production. Contract testing with Pact provides that mechanism: the `can-i-deploy` check makes compatibility verification a pipeline gate, not a human memory exercise.

Deployment order enforcement is the second pillar: even compatible versions can create incompatibility windows if deployed in the wrong order. Encoding order in pipeline `needs:` dependencies converts the runbook into executable code.

The controversial take: most microservices teams are deploying services in an order determined by whoever runs the deploy fastest. This works until it doesn't. Contract testing and deployment order enforcement are not premature optimization — they are the difference between a coordination process that works under pressure and one that fails precisely when the pressure is highest.

---

## What's Next

Chapter 15 addresses the large-scale refactoring problem: how do you make significant code changes — rewriting a module, extracting a service, replacing a database ORM — without accumulating on a long-lived feature branch that creates an integration nightmare? Branch by Abstraction is the technique that makes large changes possible on trunk.
