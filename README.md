#JWT Signing Bot for GHA Slurm Integration

This is a simple web app designed to live inside of your Munge domain that will provision an ephemeral GitHub Actions Runner on behalf of a user.

This app works in concert with the [ripley-cloud/gha-slurm](https://github.com/ripley-cloud/gha-slurm) app, which sits *outside* of the munge security domain, and talks to GitHub.

See `config.yaml.example` for an example configuration, the most important part is the script that gets launched as the Slurm job, and the mapping of repos to users.

The responsibilities for launching a GitHub Actions Runner for a given repo and talking to GitHub are separated to simplify auditing of the security-critical aspects of this app: the part that talks to Slurm must have permissions of the SlurmUser in order to launch jobs on behalf of other users. There are many other responsibilities that we might want to put in the GitHub App that *do not* require SlurmUser's permission (e.g. operations on each Actions run/pull request/etc, which can be performed using the GitHub Token passed by the webhook). If you are not doing much to change that app, it would be fine to run the two apps on the same machine, both under the SlurmUser's account, but it seemed like a better design choice for flexibility to keep this separate.

Abstracting out all of the configuration is still TODO. 

It would be very nice to have a self-serve interface to allow users to manage which GitHub repos are under their Slurm account. This should not be too hard to do using Munge on the client: a simple command line wrapper around Curl + Munge could make a REST request to this app, which could unmunge the request to authenticate the user.
