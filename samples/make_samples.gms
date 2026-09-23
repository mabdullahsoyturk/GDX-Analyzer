* Generates base.gdx and scenario.gdx, two files to try the compare view of the GDX Viewer.
*   gams make_samples.gms --scenario=0 gdx=base.gdx
*   gams make_samples.gms --scenario=1 gdx=scenario.gdx
$if not set scenario $set scenario 0

Set p 'products' / bikes 'City bikes', ebikes 'Electric bikes', scooters 'Kick scooters', helmets 'Helmets', locks 'Locks' /
    t 'months'   / jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, dec /
$ifThen %scenario% == 0
    r 'regions'  / north 'Northern region', east 'Eastern region', west 'Western region', central 'Central region' /;
$else
*   New region, and a changed element text.
    r 'regions'  / north 'Northern region', east 'Eastern region (incl. harbour)', west 'Western region', central 'Central region', south 'Southern region' /;
$endIf
Set i 'customers' / c1*c200 /
    j 'SKUs'      / s1*s40 /;

* Deterministic "random" data, identical in both files unless changed below.
Parameter price(p) 'sales price per unit'
          / bikes 450, ebikes 1800, scooters 320, helmets 45, locks 25 /
          unitCost(p) 'production cost per unit'
          / bikes 280, ebikes 1250, scooters 190, helmets 18, locks 9 /
          capacity(r) 'monthly production capacity (hours)'
          hours(p) 'production hours per unit'
          / bikes 3, ebikes 5, scooters 2, helmets 0.2, locks 0.1 /
          demand(r,p,t) 'demand in units'
          orders(i,j) 'order book (8000 records, to try paging and filtering)'
          stats(*) 'values that are hard to read in plain text';

capacity(r) = 4000;
capacity('west') = 3500;
* Reseed before each random block so the extra region of the scenario does not shift later draws.
execseed = 4711;
demand(r,p,t) = round(uniform(50, 400) * (1 + 0.3*sin(2*pi*ord(t)/12)));
execseed = 815;
orders(i,j) = round(uniform(1, 100));
stats('eps') = eps;
stats('na') = na;
stats('pinf') = +inf;
stats('minf') = -inf;
stats('tiny') = 1e-12;
stats('huge') = 1.5e+30;
stats('pi') = pi;

$ifThen %scenario% == 1
* Changed numbers.
price('ebikes') = 1650;
unitCost(p) = unitCost(p) * 1.05;
capacity('west') = 4200;
execseed = 42;
demand('south',p,t) = round(uniform(20, 150));
demand('east','ebikes',t)$(ord(t) >= 6) = round(demand('east','ebikes',t) * 1.25);
* Changes that only show up with tight tolerances (see the setting gdx.diff.eps).
hours('helmets') = 0.2 + 1e-9;
* A few changed and removed orders in a large symbol.
orders('c17','s3') = orders('c17','s3') + 5;
orders('c150','s40') = 0;
orders('c199',j)$(ord(j) <= 3) = 999;
* Changed special values.
stats('na') = 5;
stats('minf') = -1e10;
stats('new') = 42;
$endIf

* A symbol that exists only in one of the files.
$ifThen %scenario% == 0
Scalar legacyFactor 'only in base.gdx' / 1.1 /;
$else
Scalar carbonTax 'only in scenario.gdx, EUR per unit' / 12 /;
$endIf

* A symbol whose dimension differs between the files: gdxdiff cannot compare it.
$ifThen %scenario% == 0
Parameter shipCost(r) 'shipping cost per unit' / north 12, east 9, west 14, central 7 /;
$else
Parameter shipCost(r,p) 'shipping cost per unit and product';
shipCost(r,p) = 10 + ord(r) + ord(p);
$endIf

* A small production planning model, so the files contain variables and equations.
Positive Variable make(r,p,t) 'units produced', sell(r,p,t) 'units sold';
Variable profit 'total profit';
Equation defProfit 'profit definition', cap(r,t) 'capacity limit', bal(r,p,t) 'sell only what is made';
defProfit.. profit =e= sum((r,p,t), price(p)*sell(r,p,t) - unitCost(p)*make(r,p,t));
cap(r,t)..  sum(p, hours(p)*make(r,p,t)) =l= capacity(r);
bal(r,p,t).. sell(r,p,t) =l= make(r,p,t);
sell.up(r,p,t) = demand(r,p,t);
Model plan / all /;
solve plan using lp maximizing profit;

Parameter summary(*) 'solution summary';
summary('profit') = profit.l;
summary('modelstat') = plan.modelStat;
summary('solvestat') = plan.solveStat;
