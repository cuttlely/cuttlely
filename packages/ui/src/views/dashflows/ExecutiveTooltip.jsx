import { Tooltip } from '@mui/material'
import PropTypes from 'prop-types'
import { fieldLabel, formatValue, rowLabel } from './presentation'

export default function ExecutiveTooltip({ card, row, snapshot, children }) {
    const details = [
        'account_name',
        'opportunity_name',
        'renewal_date',
        'close_date',
        'renewal_acv',
        'risk_radar',
        'recorded_risk',
        'risk_signal_scope'
    ].filter((key) => row[key] != null && key !== card.valueField && key !== card.labelField)
    return (
        <Tooltip
            arrow
            enterDelay={150}
            describeChild
            componentsProps={{
                tooltip: {
                    sx: {
                        bgcolor: '#18213a',
                        border: '1px solid #64518f',
                        borderRadius: '12px',
                        maxWidth: 370,
                        boxShadow: '0 16px 48px #0008'
                    }
                },
                arrow: { sx: { color: '#18213a' } }
            }}
            title={
                <div className='df-executive-tooltip'>
                    <span className='df-tooltip-kicker'>{card.title}</span>
                    {card.labelField && <strong>{rowLabel(row, card.labelField)}</strong>}
                    <div className='df-tooltip-value'>
                        {formatValue(row[card.valueField], card.valueField)}
                        <small>{fieldLabel(card.valueField)}</small>
                    </div>
                    <p>{card.scope}</p>
                    {details.length > 0 && (
                        <dl>
                            {details.map((key) => (
                                <div key={key}>
                                    <dt>{fieldLabel(key)}</dt>
                                    <dd>{formatValue(row[key], key)}</dd>
                                </div>
                            ))}
                        </dl>
                    )}
                    {snapshot?.fetchedAt && <small>Snapshot refreshed {new Date(snapshot.fetchedAt).toLocaleString()}</small>}
                    <span className='df-tooltip-action'>Click to explore evidence →</span>
                </div>
            }
        >
            {children}
        </Tooltip>
    )
}
ExecutiveTooltip.propTypes = {
    card: PropTypes.object.isRequired,
    row: PropTypes.object.isRequired,
    snapshot: PropTypes.object,
    children: PropTypes.element.isRequired
}
