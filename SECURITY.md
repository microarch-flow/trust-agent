# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Send a report to: security@microarch-flow.dev

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact (what data could be exposed, what actions could be taken)
- Any suggested fixes

You will receive a response within 48 hours. If the issue is confirmed, we will release a patch as soon as possible.

## Scope

This project's security boundary is the Trust Gate layer that prevents secret file contents from reaching the cloud LLM. Reports within this scope are highest priority:

- Secret file contents leaking to cloud LLM inputs or outputs
- Guard bypass techniques (token obfuscation, semantic reconstruction)
- Prompt injection via secret file contents reaching the Patcher
- Info budget circumvention allowing unbounded information extraction

Out of scope: vulnerabilities in third-party dependencies (report to the upstream project), issues requiring physical access to the local machine.
