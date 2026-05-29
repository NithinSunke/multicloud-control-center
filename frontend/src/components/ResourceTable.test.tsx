import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResourceTable } from './ResourceTable';

const rows = [
  { vmid: 100, name: 'app-server', status: 'running', cpu: 0.2 },
  { vmid: 101, name: 'db-server', status: 'stopped', cpu: 0 },
  { vmid: 102, name: 'worker', status: 'running', cpu: 0.6 },
];

function renderTable() {
  render(
    <ResourceTable
      columns={[
        { key: 'vmid', label: 'VM ID' },
        { key: 'name', label: 'Name' },
        { key: 'status', label: 'Status' },
        { key: 'cpu', label: 'CPU' },
      ]}
      emptyText="No virtual machines found."
      rows={rows}
      title="Virtual Machines"
    />,
  );
}

it('filters rows by search and status', async () => {
  const user = userEvent.setup();
  renderTable();

  await user.type(screen.getByPlaceholderText(/search/i), 'db');
  expect(screen.getByText('db-server')).toBeInTheDocument();
  expect(screen.queryByText('app-server')).not.toBeInTheDocument();

  await user.clear(screen.getByPlaceholderText(/search/i));
  await user.selectOptions(screen.getByDisplayValue(/all statuses/i), 'stopped');

  expect(screen.getByText('db-server')).toBeInTheDocument();
  expect(screen.queryByText('worker')).not.toBeInTheDocument();
});

it('sorts rows from table headers', async () => {
  const user = userEvent.setup();
  renderTable();

  await user.click(screen.getByRole('button', { name: /name/i }));

  const bodyRows = within(screen.getAllByRole('rowgroup')[1]).getAllByRole('row');
  expect(within(bodyRows[0]).getByText('app-server')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /name/i }));

  const sortedRows = within(screen.getAllByRole('rowgroup')[1]).getAllByRole('row');
  expect(within(sortedRows[0]).getByText('worker')).toBeInTheDocument();
});
