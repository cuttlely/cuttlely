import type { IHarnessCaller } from '../Interface'

/** The node option a Harness card reads. A missing caller is passed as missing, so the harness engine refuses the run. */
export function harnessNodeOptions(caller?: IHarnessCaller): { harnessCaller?: IHarnessCaller } {
    if (!caller) return {}
    return caller.via === 'api_key'
        ? { harnessCaller: { via: 'api_key', apiKeyId: caller.apiKeyId, harnesses: [...caller.harnesses] } }
        : { harnessCaller: { via: caller.via } }
}
