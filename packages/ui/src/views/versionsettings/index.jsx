// Version History settings: the GitHub card, with the Dev or Prod label for this server.
// For the organization owner only.
import { Stack } from '@mui/material'

import MainCard from '@/ui-component/cards/MainCard'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import GithubCard from './GithubCard'

const VersionSettings = () => (
    <MainCard>
        <Stack flexDirection='column' sx={{ gap: 3 }}>
            <ViewHeader title='Version History' description='Every published version of every flow is kept on this server.' />
            <GithubCard />
        </Stack>
    </MainCard>
)

export default VersionSettings
