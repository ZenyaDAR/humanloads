# Security policy

humanloads is a static site: no accounts and no stored user data. It reads public APIs from the browser. README badges
for packages outside the static set come from a small service ([`server/`](server/)) that stores package names, their
badges and the days each badge was requested, nothing about readers.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on this repository
(private vulnerability reporting). Do not open a public issue.

In scope, for example: script injection through package names, descriptions or other API data; a way to make
the site or its badges show content an attacker controls; a way to take the badge service down, run up its costs or
push names into the nightly build; problems in the build and deploy workflows.

You can expect a first reply within a week. Only the latest deployed version of the site is supported.
