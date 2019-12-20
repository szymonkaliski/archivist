const React = require("react");
const ReactDOM = require("react-dom");
const { Grid, AutoSizer } = require("react-virtualized");

const DATA = [];

for (let i = 0; i < 10000; i++) {
  DATA.push(`item: ${i}`);
}

const createCellRenderer = ({ columnCount }) => ({
  columnIndex,
  rowIndex,
  key,
  style
}) => {
  const index = columnIndex + rowIndex * columnCount;
  const hasData = !!DATA[index];

  return (
    <div key={key} style={style}>
      {hasData ? (
        <div className="ba b--light-gray h-100">{DATA[index]}</div>
      ) : null}
    </div>
  );
};

const calcCellSize = ({ width }) => {
  return width / Math.floor(width / 300);
};

const App = () => (
  <div className="sans-serif w-100 vh-100">
    <AutoSizer>
      {({ width, height }) => {
        const cellSize = calcCellSize({ width, height });
        const columnCount = Math.max(width / cellSize, 1);
        const cellRenderer = createCellRenderer({ columnCount });

        return (
          <Grid
            cellRenderer={cellRenderer}
            columnCount={columnCount}
            columnWidth={cellSize}
            rowHeight={cellSize}
            rowCount={Math.ceil(DATA.length / columnCount)}
            height={height}
            width={width}
          />
        );
      }}
    </AutoSizer>
  </div>
);

ReactDOM.render(<App />, document.getElementById("app"));
