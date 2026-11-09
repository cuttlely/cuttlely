export const apiKeyOwnerNotice = (ownerUserId) => (ownerUserId ? '' : 'No recorded owner — review or rotate')

export const apiKeyRevokeConfirmation = (key) => ({
    title: 'Revoke access key',
    description: `Revoke key [${key.keyName}]? This stops new requests using all of its credentials. Admitted runs may finish. ${
        key.accessPolicy?.allResources
            ? 'This key grants all current and future resources in its workspace.'
            : `${key.resources?.length ?? key.chatFlows?.length ?? 0} resource grants are affected.`
    }`,
    confirmButtonName: 'Revoke',
    cancelButtonName: 'Cancel',
    customBtnId: 'btn_initiateDeleteApiKey'
})
