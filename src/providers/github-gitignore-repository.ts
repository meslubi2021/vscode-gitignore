import * as https from 'https';
import * as fs from 'fs';
import * as url from 'url';
import { WriteStream } from 'fs';

import { userAgent, getAgent } from '../http-client';
import { Cache, CacheItem } from '../cache';
import { GitignoreProvider, GitignoreTemplate, GitignoreOperation, GitignoreOperationType } from '../interfaces'


interface GithubRepositoryItem {
	name: string;
	path: string;
	download_url: string;
	type: string;
}

/**
 * Github gitignore template provider based on the "/repos" endpoint of the Github REST API
 * https://docs.github.com/en/rest/repos/contents
 */
export class GithubGitignoreRepositoryProvider implements GitignoreProvider {
	private readonly defaultHeaders = {
		'User-Agent': userAgent,
		//'Authorization': getAuthorizationHeaderValue()
	}

	constructor(private cache: Cache) {
	}

	/**
	 * Get all .gitignore templates
	 */
	public getTemplates(): PromiseLike<GitignoreTemplate[]> {
		// Get lists of .gitignore files from Github
		return Promise.all([
			this.getFiles(),
			this.getFiles('Global')
		])
			// Merge the two result sets
			.then((result) => {
				const files: GitignoreTemplate[] = Array.prototype.concat.apply([], result)
					.sort((a: GitignoreTemplate, b: GitignoreTemplate) => a.name.localeCompare(b.name));
				return files;
			});
	}

	/**
	 * Get all .gitignore files in a directory of the repository
	 */
	private getFiles(path = ''): Thenable<GitignoreTemplate[]> {
		return new Promise((resolve, reject) => {
			// If cached, return cached content
			const item = this.cache.get('gitignore/' + path);
			if(typeof item !== 'undefined') {
				resolve(item);
				return;
			}

			/*
			curl \
				-H "Accept: application/vnd.github.v3+json" \
				https://api.github.com/gitignore/templates
			*/
			const fullUrl = new url.URL(path, 'https://api.github.com/repos/github/gitignore/contents/');
			const options: https.RequestOptions = {
				agent: getAgent(),
				method: 'GET',
				hostname: fullUrl.hostname,
				path: fullUrl.pathname,
				headers: {...this.defaultHeaders, 'Accept': 'application/vnd.github.v3+json'},
			};
			const req = https.request(options, res => {
				const data : any[] = [];

				console.log(`vscode-gitignore: Github API ratelimit remaining: ${res.headers['x-ratelimit-remaining']}`);

				res.on('data', chunk => {
					data.push(chunk);
				});

				res.on('end', () => {
					const responseBody: string = Buffer.concat(data).toString();

					if(res.statusCode != 200) {
						return reject(responseBody);
					}

					const items: GithubRepositoryItem[] = JSON.parse(responseBody);

					const templates = items
						.filter(item => {
							return (item.type === 'file' && item.name.endsWith('.gitignore'));
						})
						.map(item => {
							return <GitignoreTemplate>{
								name: item.name.replace(/\.gitignore/, ''),
								path: item.path
							};
						});

					// Cache the retrieved gitignore templates
					this.cache.add(new CacheItem('gitignore/' + path, templates));

					resolve(templates);
				});
			})
			.on('error', err => {
				return reject(err.message);
			});

			req.end();
		});
	}

	/**
	 * Downloads a .gitignore from the repository to the path passed
	 */
	public download(operation: GitignoreOperation): Thenable<GitignoreOperation> {
		return new Promise((resolve, reject) => {
			const flags = operation.type === GitignoreOperationType.Overwrite ? 'w' : 'a';
			const file = fs.createWriteStream(operation.path, { flags: flags });

			// If appending to the existing .gitignore file, write a NEWLINE as separator
			if(flags === 'a') {
				file.write('\n');
			}

			/*
			curl \
				-H "Accept: application/vnd.github.v3.raw" \
				https://api.github.com/repos/github/gitignore/contents/<path>
			*/
			const fullUrl = new url.URL(operation.template.path, 'https://api.github.com/repos/github/gitignore/contents/');
			const options: https.RequestOptions = {
				agent: getAgent(),
				method: 'GET',
				hostname: fullUrl.hostname,
				path: fullUrl.pathname,
				headers: {...this.defaultHeaders, 'Accept': 'application/vnd.github.v3.raw'}
			};

			const req = https.request(options, response => {
				console.log(`vscode-gitignore: Github API ratelimit remaining: ${response.headers['x-ratelimit-remaining']}`);

				if(response.statusCode != 200) {
					return reject(new Error('Download failed with status code ' + response.statusCode));
				}

				response.pipe(file);

				file.on('finish', () => {
					file.close();
					resolve(operation);
				});
			}).on('error', (err) => {
				// Delete the .gitignore file if we created it
				if(flags === 'w') {
					fs.unlink(operation.path, err => {
						if(err) console.error(err.message);
					});
				}
				reject(err.message);
			});

			req.end();
		});
	}

	/**
	 * Downloads a .gitignore from the repository to the path passed
	 */
	public downloadToStream(operation: GitignoreOperation, stream: WriteStream): Thenable<GitignoreOperation> {
		if(operation.template == null) {
			throw new Error('Template cannot be null');
		}

		return new Promise((resolve, reject) => {
			/*
			curl \
				-H "Accept: application/vnd.github.v3.raw" \
				https://api.github.com/repos/github/gitignore/contents/<path>
			*/
			const fullUrl = new url.URL(operation.template.path, 'https://api.github.com/repos/github/gitignore/contents/');
			const options: https.RequestOptions = {
				agent: getAgent(),
				method: 'GET',
				hostname: fullUrl.hostname,
				path: fullUrl.pathname,
				headers: {...this.defaultHeaders, 'Accept': 'application/vnd.github.v3.raw'}
			};

			const req = https.request(options, response => {
				console.log(`vscode-gitignore: Github API ratelimit remaining: ${response.headers['x-ratelimit-remaining']}`);

				if(response.statusCode != 200) {
					return reject(new Error('Download failed with status code ' + response.statusCode));
				}

				response.pipe(stream);

				stream.on('finish', () => {
					stream.close();
					resolve(operation);
				});
			}).on('error', (err) => {
				reject(err.message);
			});

			req.end();
		});
	}
}