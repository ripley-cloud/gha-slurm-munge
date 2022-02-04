import BodyParser from 'body-parser';
import { exec } from 'child_process';
import * as dotenv from 'dotenv';
import Express, { NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import * as jwt from 'jsonwebtoken';
import * as http from 'http';
import { StatusCodes } from 'http-status-codes';
import { AddressInfo } from 'net';
import fetch from 'node-fetch';
import { Stream } from 'stream';
import YAML from 'yaml';

dotenv.config();

type ConfigFormat = {
    repositories: RepoConfig[];
    jobTemplate: string;
    logging?: "DEBUG";
    ghaSharedSecret: string;
}
type RepoConfig = {
    gitHubURL: string;
    slurmUser: string;
}
type GHWorkerBatchRequest = {
    gitHubURL: string;
    launcherToken: string;
    runnerName?: string;
    runnerLabels?: string;
    cpus?: string;
    duration?: string;
    partition?: string;
    memory?: string;
    exclusive?: string;
}
function streamToString(stream: Stream) {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    })
}
class SlurmGitHubWokerGateway {
    private _refreshJWTAt: number = 0;
    private _jwtToken: Promise<string> = new Promise((resolve) => resolve("empty"));
    private _configFile: string;
    private config: ConfigFormat;

    constructor(configFile: string) {
        this._configFile = configFile;
        this.config = this.reloadConfig();
    }
    _log(message: string, level: string = "DEBUG") {
        if (this.config && this.config.logging) {
            console.log(message);
        }
    }
    _debugLogObject(object: object) {
        if (this.config.logging) {
            console.log(JSON.stringify(object, null, 2));
        }
    }
    reloadConfig() {
        this._log("Reloading config from " + this._configFile);
        if (!fs.existsSync(this._configFile)) {
            throw "Config file does not exist: " + this._configFile;
        }
        this.config = YAML.parse(fs.readFileSync(this._configFile, "utf-8")) as ConfigFormat;
        this._log("Config re-loaded: " + this._configFile);
        if (!this.config.ghaSharedSecret) {
            throw "Invalid config - no GHA shared secret!";
        }
        return this.config;
    }
    validateToken(req: Request, res: Response, next: NextFunction) {
        const token = req.headers['auth-token'];
        if (!token || token != this.config.ghaSharedSecret) {
            this._log("Invaild auth token received: " + token);
            return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'auth-token missing' })
        }
        next();
    }

    private async _getTokenFromScontrol(): Promise<string> {
        return new Promise((resolve, reject) => {
            this._log("Renewing JWT token");
            const scontrolRet = exec("sudo scontrol token", (error, stdout, stderr) => {
                if (error) {
                    this._log("Renewing JWT token failed");
                    reject(error);
                    return;
                }
                let str = stdout.trim().substring(10);
                this._log("Renewing JWT token: success");
                resolve(str);
            });
        });
    }
    async getJWTToken() {
        if (this._refreshJWTAt < Date.now()) {
            this._log("JWT token might be expired, renewing");
            this._refreshJWTAt = Date.now() + 1000 * 60 * 10; //refresh every 10 minutes
            this._jwtToken = this._getTokenFromScontrol();
        }
        return this._jwtToken;
    }
    escapeShellArg(arg: string) {
        return `'${arg.replace(/'/g, `'\\''`)}'`;
    }
    async launchGHABuild(req: GHWorkerBatchRequest) {
        
        const token = await this.getJWTToken();
        const buildConfig = this.config.repositories.find((r) => r.gitHubURL == req.gitHubURL);
        if (!buildConfig) {
            throw "No configuration found for GitHub URL " + req.gitHubURL;
        }
        this._log("Received runner launch request:");
        this._debugLogObject(req);
        let partition = "gha";
        if(req.runnerLabels && req.runnerLabels.includes('32gb')){
            partition = "32GBRAM";
        }
        let jobCfg = {
            comment: "GitHub Actions Builder for " + req.gitHubURL,
            name: "GitHubActions",
            ntasks: 1,
            partition: partition,//req.partition,
            cpus_per_task: req.cpus,
            exclusive: req.exclusive,
            memory_per_node: req.memory,
			//get_user_environment: true,
            // standard_output: "/ci-logs/gha-stdout",
            // standard_error: "/ci-logs/gha-stder",
            standard_output: "/tmp/gha-stdout",
            standard_error: "/tmp/gha-stderr",
            current_working_directory: "/tmp",
			//TODO: 'environment' is not respected at all. Looks like a bug in SlurmRestd - should make MWE and submit bug report
			// environment: {"fooo":"bar"}
            //environment: { PATH: "/bin:/usr/bin:/usr/local/bin", HOME: "/tmp/home/"+buildConfig.slurmUser, FOO:'bar2' }
        };

        let commandLine = "--unattended --replace --url " + req.gitHubURL + " --token $GHTOKEN --ephemeral --work gha_work";
        if (req.runnerName) {
            commandLine += " --name " + this.escapeShellArg(req.runnerName) + " ";
        }
        if (req.runnerLabels) {
            commandLine += " --labels " + this.escapeShellArg(req.runnerLabels) + " ";
        }
        console.log(commandLine);
        const batchReq = {
            script: this.config.jobTemplate
				.replace("$USER",buildConfig.slurmUser)
                .replace(/%RUNNER_CONFIG_LINE%/g, commandLine)
                .replace("%LAUNCH_TOKEN%", req.launcherToken)
                .replace(/\%LOG_FILE\%/g, "/tmp/gha-stdout"),
            job: jobCfg,
        };

        this._log("Making request to slurm:");
        this._log(JSON.stringify(batchReq));

        try {
        const response = await fetch('http://127.0.0.1:6820/slurm/v0.0.36/job/submit', {
            headers: {
                'Content-Type': 'application/json',
                'Accept': "application/json",
                'X-SLURM-USER-NAME': buildConfig.slurmUser,
                'X-SLURM-USER-TOKEN': token
            },
            method: 'POST',
            body: JSON.stringify(batchReq)
        });
            const result = await streamToString(response.body)
            console.log(result);
            this._log("Successfully reuqested job");
        } catch (err) {
            console.log("Error submitting job:");
            console.error(err);
        }

    }
}

const gw = new SlurmGitHubWokerGateway(process.env.GHA_SLURM_JWT_CONFIG || "config.yaml");
const app = Express();
const server = http.createServer(app);
app.post('/api/reload', BodyParser.json(), gw.validateToken.bind(gw), async (req, res) => {
    gw.reloadConfig();
    res.status(StatusCodes.OK).json({ status: "OK!" })
});
app.post('/runner/start', BodyParser.json(), gw.validateToken.bind(gw), async (req, res) => {
	try{
    	await gw.launchGHABuild(req.body);
    	res.status(StatusCodes.OK).json({ status: "OK!" })
	} catch(err){
		console.trace(err);
		res.status(500).send("Error");
	}
});
app.post('/config/repos', BodyParser.text(), async (req, res) => {
	//TODO allow users to make requests to claim a repo. Can write a simple CLI app that uses munge to sign the request
   const scontrolRet = exec("unmunge ", (error, stdout, stderr) => {
	   console.log(stdout);
   });
   scontrolRet.stdin?.write(req.body);
   scontrolRet.stdin?.end();
	console.log(req.body);
    res.status(StatusCodes.OK).json({ status: "OK!" })
});
app.delete('/config/repos', BodyParser.text(), async (req, res) => {
	//TODO allow users to make requests to remove a repo from their account. Can write a simple CLI app that uses munge to sign the request
   const scontrolRet = exec("unmunge ", (error, stdout, stderr) => {
	   console.log(stdout);
   });
   scontrolRet.stdin?.write(req.body);
   scontrolRet.stdin?.end();
	console.log(req.body);
    res.status(StatusCodes.OK).json({ status: "OK!" })
});
app.get('/config/repos', BodyParser.text(), async (req, res) => {
	//TODO allow users to make requests to list the repos that are mapped to their username (again, use munge on client side)
   /*(const token = req.headers['auth-token'];
   const scontrolRet = exec("unmunge ", (error, stdout, stderr) => {
	   console.log(stdout);
   });
   scontrolRet.stdin?.write(token);
   scontrolRet.stdin?.end();
	console.log(req.body);
    res.status(StatusCodes.OK).json({ status: "OK!" })
   */
});



server.listen(process.env.PORT || 5011, () => {
    const address = server.address() as AddressInfo;
    // eslint-disable-next-line no-console
    console.log(`GHA JWT Slurm Server Listening on ${address.port}`);
});
