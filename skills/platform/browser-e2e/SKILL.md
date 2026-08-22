---
name: browser-e2e
description: Use when validating a real web application through browser-visible flows, navigation, forms, auth, network calls, console errors and responsive UI behavior.
metadata: {version: "1.0.0", category: platform, risk: medium}
---
# Browser End-to-End Verification

## When to Use
Critical user journeys, regression verification, production smoke tests, UI bugs, auth flows, forms and integration behavior visible from the browser.

## When NOT to Use
A unit-level business rule that can be proven faster without a browser.

## Inputs
Target environment, flow, test account/data policy, expected UI/network outcomes and allowed mutations.

## Workflow
1. Start from a clean browser context appropriate to the test.
2. Navigate as a user would; do not bypass the failing path with internal APIs unless isolating root cause.
3. Observe page rendering, loading states, accessibility-critical controls and navigation.
4. Capture console errors and failed/slow network requests.
5. Verify server responses and UI state agree.
6. Exercise negative/edge behavior for critical forms and permissions.
7. Avoid destructive production writes unless explicitly approved; use isolated test data when possible.
8. Re-run the original failing flow after any fix.
9. Record reproducible steps and the environment/deployment tested.

## Verification Gate
The complete user-visible flow reaches the expected state with no relevant console/network error hidden behind a visually successful screen.

## Failure / Rollback
If an external dependency prevents completion, isolate and report that boundary rather than declaring the application fixed.
