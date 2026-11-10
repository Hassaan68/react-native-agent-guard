# Security Policy

## Supported Versions

Because `react-native-agent-guard` enforces permission boundaries, policy gates (`'auto' | 'confirm' | 'biometric' | 'deny'`), and input validation for autonomous AI agents in React Native, security is our highest priority.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, please report suspected vulnerabilities privately by emailing:

- **Email**: [hassaanmuhammad526@gmail.com](mailto:hassaanmuhammad526@gmail.com)

### What to Include in Your Report

To help us triage and resolve the issue quickly, please include:

1. **Description of the Vulnerability**: Explain the nature of the issue (e.g., policy bypass, schema validation bypass, race condition in approval queue, or prototype pollution).
2. **Affected Version(s)**: The exact version of `react-native-agent-guard`, `zod`, and `react-native` tested.
3. **Minimal Proof-of-Concept (PoC)**: Step-by-step reproduction instructions or a self-contained TypeScript/Jest snippet demonstrating the bypass or issue.
4. **Impact Assessment**: What an untrusted LLM output or malicious tool invocation could achieve if exploited.

### Response & Disclosure Timeline

- **Initial Acknowledgment**: Within **48 hours** of receiving your report.
- **Status Update & Triage**: Within **5 business days** with confirmation of the issue and remediation plan.
- **Patch & Coordinated Disclosure**: Once a fix is released on npm, we will publish a security advisory and credit you (unless you prefer to remain anonymous).
