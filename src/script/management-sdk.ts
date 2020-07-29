import * as fs from "fs";
import * as path from "path";
import slash = require("slash");
import * as recursiveFs from "recursive-fs";
import * as yazl from "yazl";
import Adapter from "../utils/adapter/adapter"
import RequestManager from "../utils/request-manager"
import { CodePushUnauthorizedError } from "../utils/code-push-error"

import { AccessKey, AccessKeyRequest, Account, App, AppCreationRequest, CodePushError, CollaboratorMap, CollaboratorProperties, Deployment, DeploymentMetrics, Headers, Package, PackageInfo, ServerAccessKey, Session, UpdateMetrics } from "./types";

interface JsonResponse {
    headers: Headers;
    body?: any;
}

interface PackageFile {
    isTemporary: boolean;
    path: string;
}

// A template string tag function that URL encodes the substituted values
function urlEncode(strings: TemplateStringsArray, ...values: string[]): string {
    var result = "";
    for (var i = 0; i < strings.length; i++) {
        result += strings[i];
        if (i < values.length) {
            result += encodeURIComponent(values[i]);
        }
    }

    return result;
}

class AccountManager {
    public static AppPermission = {
        OWNER: "Owner",
        COLLABORATOR: "Collaborator"
    };

    private _accessKey: string;
    private _requestManager: RequestManager;
    private _adapter: Adapter;

    constructor(accessKey: string, customHeaders?: Headers, serverUrl?: string, proxy?: string) {
        if (!accessKey) throw new CodePushUnauthorizedError("A token must be specified.");

        this._accessKey = accessKey;
        this._requestManager = new RequestManager(accessKey, customHeaders, serverUrl, proxy);
        this._adapter = new Adapter(this._requestManager);
    }

    public get accessKey(): string {
        return this._accessKey;
    }

    public isAuthenticated(throwIfUnauthorized?: boolean): Promise<boolean> {
        return this._requestManager.get(urlEncode`/user`)
            .then((res: JsonResponse) => {
                const authenticated: boolean = !!res.body;

                if (!authenticated && throwIfUnauthorized) {
                    throw new Error("Unauthorized.");
                }
                return authenticated;
            });
    }

    public addAccessKey(friendlyName: string, ttl?: number): Promise<AccessKey> {
        if (!friendlyName) {
            throw new CodePushUnauthorizedError("A name must be specified when adding an access key.");
        }

        var accessKeyRequest: AccessKeyRequest = {
            description: friendlyName
        };

        return this._requestManager.post(urlEncode`/api_tokens`, JSON.stringify(accessKeyRequest), /*expectResponseBody=*/ true)
            .then((response: JsonResponse) => {
                return this._adapter.toLegacyAccessKey(response.body);
            });
    }

    public getAccessKey(accessKeyName: string): Promise<AccessKey> {
        return this._requestManager.get(urlEncode`/accessKeys/${accessKeyName}`)
            .then((res: JsonResponse) => {
                return {
                    createdTime: res.body.accessKey.createdTime,
                    expires: res.body.accessKey.expires,
                    name: res.body.accessKey.friendlyName,
                };
            })
    }

    public getAccessKeys(): Promise<AccessKey[]> {
        return this._requestManager.get(urlEncode`/api_tokens`)
            .then((res: JsonResponse) => {
                return this._adapter.toLegacyAccessKeyList(res.body);
            });
    }

    public getSessions(): Promise<Session[]> {
        return this._requestManager.get(urlEncode`/accessKeys`)
            .then((res: JsonResponse) => {
                // A machine name might be associated with multiple session keys,
                // but we should only return one per machine name.
                var sessionMap: { [machineName: string]: Session } = {};
                var now: number = new Date().getTime();
                res.body.accessKeys.forEach((serverAccessKey: ServerAccessKey) => {
                    if (serverAccessKey.isSession && serverAccessKey.expires > now) {
                        sessionMap[serverAccessKey.createdBy] = {
                            loggedInTime: serverAccessKey.createdTime,
                            machineName: serverAccessKey.createdBy
                        };
                    }
                });

                var sessions: Session[] = Object.keys(sessionMap)
                    .map((machineName: string) => sessionMap[machineName]);

                return sessions;
            });
    }


    public patchAccessKey(oldName: string, newName?: string, ttl?: number): Promise<AccessKey> {
        var accessKeyRequest: AccessKeyRequest = {
            friendlyName: newName,
            ttl
        };

        return this._requestManager.patch(urlEncode`/accessKeys/${oldName}`, JSON.stringify(accessKeyRequest))
            .then((res: JsonResponse) => {
                return {
                    createdTime: res.body.accessKey.createdTime,
                    expires: res.body.accessKey.expires,
                    name: res.body.accessKey.friendlyName,
                };
            });
    }

    public removeAccessKey(name: string): Promise<void> {
        return this._requestManager.del(urlEncode`/accessKeys/${name}`)
            .then(() => null);
    }

    public removeSession(machineName: string): Promise<void> {
        return this._requestManager.del(urlEncode`/sessions/${machineName}`)
            .then(() => null);
    }

    // Account
    public getAccountInfo(): Promise<Account> {
        return this._requestManager.get(urlEncode`/user`)
            .then((res: JsonResponse) => {
                return this._adapter.toLegacyAccount(res.body);
            });
    }

    // Apps
    public getApps(): Promise<App[]> {
        return this._requestManager.get(urlEncode`/apps`)
            .then((res: JsonResponse) => res.body.apps);
    }

    public getApp(appName: string): Promise<App> {
        return this._requestManager.get(urlEncode`/apps/${this.appNameParam(appName)}`)
            .then((res: JsonResponse) => res.body.app);
    }

    public addApp(appName: string, appOs: string, appPlatform: string, manuallyProvisionDeployments: boolean = false): Promise<App> {
        var app: AppCreationRequest = {
            name: appName,
            os: appOs,
            platform: appPlatform,
            manuallyProvisionDeployments: manuallyProvisionDeployments
        };
        return this._requestManager.post(urlEncode`/apps/`, JSON.stringify(app), /*expectResponseBody=*/ false)
            .then(() => app);
    }

    public removeApp(appName: string): Promise<void> {
        return this._requestManager.del(urlEncode`/apps/${this.appNameParam(appName)}`)
            .then(() => null);
    }

    public renameApp(oldAppName: string, newAppName: string): Promise<void> {
        return this._requestManager.patch(urlEncode`/apps/${this.appNameParam(oldAppName)}`, JSON.stringify({ name: newAppName }))
            .then(() => null);
    }

    public transferApp(appName: string, email: string): Promise<void> {
        return this._requestManager.post(urlEncode`/apps/${this.appNameParam(appName)}/transfer/${email}`, /*requestBody=*/ null, /*expectResponseBody=*/ false)
            .then(() => null);
    }

    // Collaborators
    public getCollaborators(appName: string): Promise<CollaboratorMap> {
        return this._requestManager.get(urlEncode`/apps/${this.appNameParam(appName)}/collaborators`)
            .then((res: JsonResponse) => res.body.collaborators);
    }

    public addCollaborator(appName: string, email: string): Promise<void> {
        return this._requestManager.post(urlEncode`/apps/${this.appNameParam(appName)}/collaborators/${email}`, /*requestBody=*/ null, /*expectResponseBody=*/ false)
            .then(() => null);
    }

    public removeCollaborator(appName: string, email: string): Promise<void> {
        return this._requestManager.del(urlEncode`/apps/${this.appNameParam(appName)}/collaborators/${email}`)
            .then(() => null);
    }

    // Deployments
    public addDeployment(appName: string, deploymentName: string): Promise<Deployment> {
        var deployment = <Deployment>{ name: deploymentName };
        return this._requestManager.post(urlEncode`/apps/${this.appNameParam(appName)}/deployments/`, JSON.stringify(deployment), /*expectResponseBody=*/ true)
            .then((res: JsonResponse) => res.body.deployment);
    }

    public clearDeploymentHistory(appName: string, deploymentName: string): Promise<void> {
        return this._requestManager.del(urlEncode`/apps/${this.appNameParam(appName)}/deployments/${deploymentName}/history`)
            .then(() => null);
    }

    public getDeployments(appName: string): Promise<Deployment[]> {
        return this._requestManager.get(urlEncode`/apps/${this.appNameParam(appName)}/deployments/`)
            .then((res: JsonResponse) => this._adapter.toLegacyDeployments(res.body));
    }

    public getDeployment(appName: string, deploymentName: string): Promise<Deployment> {
        return this._requestManager.get(urlEncode`/apps/${this.appNameParam(appName)}/deployments/${deploymentName}`)
            .then((res: JsonResponse) => res.body.deployment);
    }

    public renameDeployment(appName: string, oldDeploymentName: string, newDeploymentName: string): Promise<void> {
        return this._requestManager.patch(urlEncode`/apps/${this.appNameParam(appName)}/deployments/${oldDeploymentName}`, JSON.stringify({ name: newDeploymentName }))
            .then(() => null);
    }

    public removeDeployment(appName: string, deploymentName: string): Promise<void> {
        return this._requestManager.del(urlEncode`/apps/${this.appNameParam(appName)}/deployments/${deploymentName}`)
            .then(() => null);
    }

    public getDeploymentMetrics(appName: string, deploymentName: string): Promise<DeploymentMetrics> {
        return this._requestManager.get(urlEncode`/apps/${this.appNameParam(appName)}/deployments/${deploymentName}/metrics`)
            .then((res: JsonResponse) => res.body.metrics);
    }

    public getDeploymentHistory(appName: string, deploymentName: string): Promise<Package[]> {
        return this._requestManager.get(urlEncode`/apps/${this.appNameParam(appName)}/deployments/${deploymentName}/history`)
            .then((res: JsonResponse) => res.body.history);
    }

    // public release(appName: string, deploymentName: string, filePath: string, targetBinaryVersion: string, updateMetadata: PackageInfo, uploadProgressCallback?: (progress: number) => void): Promise<Package> {

    //     return new Promise<Package>((resolve, reject) => {

    //         updateMetadata.appVersion = targetBinaryVersion;
    //         var request: superagent.Request = superagent.post(this._serverUrl + urlEncode`/apps/${this.appNameParam(appName)}/deployments/${deploymentName}/release`);
    //         if (this._proxy) (<any>request).proxy(this._proxy);
    //         this.attachCredentials(request);

    //         var getPackageFilePromise: Promise<PackageFile> = this.packageFileFromPath(filePath);

    //         getPackageFilePromise.then((packageFile: PackageFile) => {
    //             var file: any = fs.createReadStream(packageFile.path);
    //             request.attach("package", file)
    //                 .field("packageInfo", JSON.stringify(updateMetadata))
    //                 .on("progress", (event: any) => {
    //                     if (uploadProgressCallback && event && event.total > 0) {
    //                         var currentProgress: number = event.loaded / event.total * 100;
    //                         uploadProgressCallback(currentProgress);
    //                     }
    //                 })
    //                 .end((err: any, res: superagent.Response) => {

    //                     if (packageFile.isTemporary) {
    //                         fs.unlinkSync(packageFile.path);
    //                     }

    //                     if (err) {
    //                         reject(this.getCodePushError(err, res));
    //                         return;
    //                     }

    //                     try {
    //                         var body = JSON.parse(res.text);
    //                     } catch (err) {
    //                         reject(<CodePushError>{ message: `Could not parse response: ${res.text}`, statusCode: AccountManager.ERROR_INTERNAL_SERVER });
    //                         return;
    //                     }

    //                     if (res.ok) {
    //                         resolve(<Package>body.package);
    //                     } else {
    //                         reject(<CodePushError>{ message: body.message, statusCode: res && res.status });
    //                     }
    //                 });
    //         });
    //     });
    // }

    public patchRelease(appName: string, deploymentName: string, label: string, updateMetadata: PackageInfo): Promise<void> {
        updateMetadata.label = label;
        var requestBody: string = JSON.stringify({ packageInfo: updateMetadata });
        return this._requestManager.patch(urlEncode`/apps/${this.appNameParam(appName)}/deployments/${deploymentName}/release`, requestBody, /*expectResponseBody=*/ false)
            .then(() => null);
    }

    public promote(appName: string, sourceDeploymentName: string, destinationDeploymentName: string, updateMetadata: PackageInfo): Promise<Package> {
        var requestBody: string = JSON.stringify({ packageInfo: updateMetadata });
        return this._requestManager.post(urlEncode`/apps/${this.appNameParam(appName)}/deployments/${sourceDeploymentName}/promote/${destinationDeploymentName}`, requestBody, /*expectResponseBody=*/ true)
            .then((res: JsonResponse) => res.body.package);
    }

    public rollback(appName: string, deploymentName: string, targetRelease?: string): Promise<void> {
        return this._requestManager.post(urlEncode`/apps/${this.appNameParam(appName)}/deployments/${deploymentName}/rollback/${targetRelease || ``}`, /*requestBody=*/ null, /*expectResponseBody=*/ false)
            .then(() => null);
    }

    private packageFileFromPath(filePath: string): Promise<PackageFile> {
        var getPackageFilePromise: Promise<PackageFile>;
        if (fs.lstatSync(filePath).isDirectory()) {
            getPackageFilePromise = new Promise<PackageFile>((resolve: (file: PackageFile) => void, reject: (reason: Error) => void): void => {
                var directoryPath: string = filePath;

                recursiveFs.readdirr(directoryPath, (error?: any, directories?: string[], files?: string[]): void => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    var baseDirectoryPath = path.dirname(directoryPath);
                    var fileName: string = this.generateRandomFilename(15) + ".zip";
                    var zipFile = new yazl.ZipFile();
                    var writeStream: fs.WriteStream = fs.createWriteStream(fileName);

                    zipFile.outputStream.pipe(writeStream)
                        .on("error", (error: Error): void => {
                            reject(error);
                        })
                        .on("close", (): void => {
                            filePath = path.join(process.cwd(), fileName);

                            resolve({ isTemporary: true, path: filePath });
                        });

                    for (var i = 0; i < files.length; ++i) {
                        var file: string = files[i];
                        var relativePath: string = path.relative(baseDirectoryPath, file);

                        // yazl does not like backslash (\) in the metadata path.
                        relativePath = slash(relativePath);

                        zipFile.addFile(file, relativePath);
                    }

                    zipFile.end();
                });
            });
        } else {
            getPackageFilePromise = new Promise<PackageFile>((resolve: (file: PackageFile) => void, reject: (reason: Error) => void): void => {
                resolve({ isTemporary: false, path: filePath });
            });
        }
        return getPackageFilePromise;
    }

    private generateRandomFilename(length: number): string {
        var filename: string = "";
        var validChar: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

        for (var i = 0; i < length; i++) {
            filename += validChar.charAt(Math.floor(Math.random() * validChar.length));
        }

        return filename;
    }

    // IIS and Azure web apps have this annoying behavior where %2F (URL encoded slashes) in the URL are URL decoded
    // BEFORE the requests reach node. That essentially means there's no good way to encode a "/" in the app name--
    // URL encoding will work when running locally but when running on Azure it gets decoded before express sees it,
    // so app names with slashes don't get routed properly. See https://github.com/tjanczuk/iisnode/issues/343 (or other sites
    // that complain about the same) for some more info. I explored some IIS config based workarounds, but the previous
    // link seems to say they won't work, so I eventually gave up on that.
    // Anyway, to workaround this issue, we now allow the client to encode / characters as ~~ (two tildes, URL encoded).
    // The CLI now converts / to ~~ if / appears in an app name, before passing that as part of the URL. This code below
    // does the encoding. It's hack, but seems like the least bad option here.
    // Eventually, this service will go away & we'll all be on Max's new service. That's hosted in docker, no more IIS,
    // so this issue should go away then.
    private appNameParam(appName: string) {
        return appName.replace("/", "~~");
    }
}

export = AccountManager;
