* Generates the GDX fixtures used by the extension tests.
$if not set variant $set variant 1
Set i 'canning plants' / seattle 'Seattle WA', san-diego 'San Diego CA' /
    j 'markets'        / new-york, chicago, topeka /;
Alias (i, ii);
Parameter a(i) 'capacity of plant i in cases'
$ifThen %variant% == 1
  / seattle 350, san-diego 600 /
$else
  / seattle 360, san-diego 600 /
$endIf
          b(j) 'demand at market j in cases' / new-york 325, chicago 300, topeka 275 /;
Table d(i,j) 'distance in thousands of miles'
              new-york  chicago  topeka
    seattle        2.5      1.7     1.8
    san-diego      2.5      1.8     1.4;
Scalar f 'freight in dollars per case per thousand miles' / 90 /;
Parameter c(i,j) 'transport cost in thousands of dollars per case';
c(i,j) = f*d(i,j)/1000;
Parameter specials(*) 'special values'
$ifThen %variant% == 1
  / eps eps, na na, pinf +inf, minf -inf /;
$else
  / eps eps, na na, pinf +inf, added 7 /;
$endIf
$ifThen %variant% == 2
Parameter extra 'only in variant 2' / 42 /;
$endIf
Variable x(i,j) 'shipment quantities in cases', z 'total transportation costs';
Positive Variable x;
Equation cost 'define objective function', supply(i) 'observe supply limit', demand(j) 'satisfy demand';
cost..      z =e= sum((i,j), c(i,j)*x(i,j));
supply(i).. sum(j, x(i,j)) =l= a(i);
demand(j).. sum(i, x(i,j)) =g= b(j);
Model transport / all /;
solve transport using lp minimizing z;
