# Sandbox backend installation point

Install a reviewed backend package in this directory. It must expose the module/class configured by `CODEMIND_SANDBOX_BACKEND` and satisfy the interface in `../README.md`.

No executable sandbox backend ships here. The runner API intentionally refuses to start until a real backend is installed and the sandbox, resource limits, egress controls, and application ingress have been verified.
